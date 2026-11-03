import type { Gate } from '../../shared/gates.ts';
import type { ClientMsg, KickCode, LeaderRow, ServerMsg } from '../../shared/protocol.ts';
import { TUNABLES } from '../../shared/tunables.ts';
import { verifySession } from './auth.ts';
import { config } from './config.ts';
import type { Db, LeaderEntry } from './db.ts';
import { checkSolve, makeLevel, type Run } from './gatedash.ts';
import { Hub } from './hub.ts';
import { checkName } from './names.ts';
import { RateLimiter } from './ratelimit.ts';
import { RavensLobby } from './ravens.ts';
import { parseClientMsg } from './validate.ts';

/** A text WebSocket as the runtime (ws on Node, a Durable Object on Cloudflare) hands it to us. */
export interface Socket {
  readonly open: boolean;
  send(text: string): void;
  close(code: number, reason: string): void;
  /** Only where the runtime exposes protocol pings (Node). Cloudflare answers pings itself. */
  ping?(): void;
  terminate?(): void;
}

/** Events the runtime forwards for one socket. */
export type SocketEvents = { message(text: string): void; pong(): void; close(): void };

export type Conn = {
  ws: Socket;
  uid: string | null;
  limiter: RateLimiter;
  alive: boolean;
  closed: boolean;
  lastChat: number;
};

/** Owns every WebSocket connection and routes validated messages. */
export class Game {
  readonly db: Db;
  readonly hub: Hub<Conn>;
  readonly ravens: RavensLobby;
  private byUid = new Map<string, Conn>();
  private conns = new Set<Conn>();
  private heartbeat: ReturnType<typeof setInterval>;
  private runs = new Map<string, Run>(); // Gate Dash runs in progress, by Discord ID
  private board: { top: LeaderEntry[]; at: number } = { top: [], at: 0 };

  constructor(db: Db) {
    this.db = db;
    this.hub = new Hub<Conn>((c, m) => this.send(c, m), (c, code) => this.kick(c, code));
    this.ravens = new RavensLobby({
      send: (uid, m) => {
        const c = this.byUid.get(uid);
        if (c) this.send(c, m);
      },
      save: (uid, score) => {
        const r = this.db.recordRavens(uid, score);
        if (r.newBest) this.board.at = 0;
        return r;
      },
    });
    // Drop half-open sockets so their birds leave the hub.
    this.heartbeat = setInterval(() => {
      for (const c of this.conns) {
        if (!c.ws.ping) continue;
        if (!c.alive) c.ws.terminate?.();
        else {
          c.alive = false;
          c.ws.ping();
        }
      }
    }, 30_000);
  }

  get online(): number {
    return this.hub.size;
  }

  onConnection(ws: Socket): SocketEvents {
    const conn: Conn = { ws, uid: null, limiter: new RateLimiter(), alive: true, closed: false, lastChat: 0 };
    this.conns.add(conn);
    const authTimer = setTimeout(() => !conn.uid && this.kick(conn, 'auth'), TUNABLES.authTimeoutMs);
    return {
      message: (text) => this.onMessage(conn, text),
      pong: () => (conn.alive = true),
      close: () => {
        clearTimeout(authTimer);
        this.detach(conn);
      },
    };
  }

  send(conn: Conn, msg: ServerMsg): void {
    if (conn.ws.open) conn.ws.send(JSON.stringify(msg));
  }

  kick(conn: Conn, code: KickCode): void {
    if (conn.closed) return;
    this.send(conn, { t: 'kicked', code });
    this.detach(conn);
    conn.ws.close(4000, code);
  }

  /** Ends the live connection of a user, e.g. when they log in again elsewhere. */
  endSessionsFor(uid: string, code: KickCode): void {
    const c = this.byUid.get(uid);
    if (c) this.kick(c, code);
  }

  shutdown(): void {
    clearInterval(this.heartbeat);
    this.hub.stop();
    this.ravens.stop();
    for (const uid of [...this.runs.keys()]) this.endRun(uid);
    for (const c of this.conns) c.ws.close(1012, 'restart');
  }

  private detach(conn: Conn): void {
    if (conn.closed) return;
    conn.closed = true;
    this.conns.delete(conn);
    if (conn.uid && this.byUid.get(conn.uid) === conn) {
      this.byUid.delete(conn.uid);
      this.hub.remove(conn.uid);
      this.endRun(conn.uid);
      this.ravens.leave(conn.uid);
    }
  }

  private onMessage(conn: Conn, text: string): void {
    if (conn.closed) return;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    const msg = parseClientMsg(raw);
    if (!msg || !conn.limiter.allow(msg.t)) return;
    if (msg.t === 'auth') return this.onAuth(conn, msg.token);
    if (!conn.uid) return;
    this.route(conn, conn.uid, msg);
  }

  private onAuth(conn: Conn, token: string): void {
    if (conn.uid) return;
    const s = verifySession(token, config.sessionSecret);
    const user = s ? this.db.getUser(s.uid) : undefined;
    if (!s || !user || user.session_id !== s.sid) return this.kick(conn, 'auth');
    if (user.banned) return this.kick(conn, 'banned');
    // One live connection per player: a second tab or device replaces the first.
    this.endSessionsFor(user.discord_id, 'replaced');
    conn.uid = user.discord_id;
    this.byUid.set(conn.uid, conn);
    this.send(conn, { t: 'welcome', profile: { name: user.name, p0: user.p0 } });
  }

  private route(conn: Conn, uid: string, msg: Exclude<ClientMsg, { t: 'auth' }>): void {
    switch (msg.t) {
      case 'claimName':
        return this.onClaimName(conn, uid, msg.name);
      case 'setBird':
        return this.onSetBird(conn, uid, msg.p0);
      case 'joinHub':
        return this.onJoinHub(conn, uid);
      case 'move':
        this.hub.move(uid, msg.x, msg.y);
        return;
      case 'ping':
        return this.send(conn, { t: 'pong' });
      case 'say':
      case 'emote':
        return this.onChat(conn, uid, msg);
      case 'gdStart':
        return this.startRun(conn, uid);
      case 'gdSolve':
        return this.onSolve(conn, uid, msg.level, msg.gates, msg.dts);
      case 'gdQuit':
        return this.endRun(uid);
      case 'lbGet':
        return this.sendLeaderboard(conn, uid);
      case 'rrJoin': {
        const user = this.db.getUser(uid);
        if (!user?.name || user.p0 === null || this.runs.has(uid)) return;
        return this.ravens.join({ uid, name: user.name, p0: user.p0 });
      }
      case 'rrLeave':
        return this.ravens.leave(uid);
      case 'rrWinds':
      case 'rrIntercept':
      case 'rrSample':
      case 'rrReact':
      case 'rrVerdict':
        return this.ravens.handle(uid, msg);
    }
  }

  private onChat(conn: Conn, uid: string, msg: Extract<ClientMsg, { t: 'say' | 'emote' }>): void {
    const now = Date.now();
    // No chat during Ravens and Robins: the two reaction buttons are the only channel.
    if (now - conn.lastChat < TUNABLES.chat.intervalMs || this.ravens.inMatch(uid)) return;
    const user = this.db.getUser(uid);
    if (!user || (user.muted_until ?? 0) > now) return this.send(conn, { t: 'error', msg: 'You are muted for now.' });
    conn.lastChat = now;
    if (msg.t === 'say') {
      if (this.hub.announce(uid, (id) => ({ t: 'said', id, p: msg.p }))) this.db.logPhrase(uid, msg.p, now);
      return;
    }
    // Collapse is decided on the server so every viewer sees the same outcome.
    this.hub.announce(uid, (id, p0) =>
      msg.e === 'collapse' ? { t: 'emoted', id, e: msg.e, o: Math.random() * 100 < p0 ? 0 : 1 } : { t: 'emoted', id, e: msg.e },
    );
  }

  private startRun(conn: Conn, uid: string): void {
    if (this.ravens.busy(uid)) return;
    if (this.runs.has(uid)) this.endRun(uid);
    const now = Date.now();
    const run: Run = {
      score: 0,
      level: makeLevel(1, now),
      endsAt: now + TUNABLES.gateDash.runMs,
      timer: setTimeout(() => this.endRun(uid), TUNABLES.gateDash.runMs),
    };
    this.runs.set(uid, run);
    this.sendLevel(conn, run, 0);
  }

  private sendLevel(conn: Conn, run: Run, gained: number): void {
    const { level, start, target, min, gates } = run.level;
    this.send(conn, { t: 'gdLevel', level, start, target, min, gates, msLeft: Math.max(0, run.endsAt - Date.now()), score: run.score, gained });
  }

  private onSolve(conn: Conn, uid: string, level: number, gates: Gate[], dts: number[]): void {
    const run = this.runs.get(uid);
    const now = Date.now();
    if (!run || level !== run.level.level || now > run.endsAt) return;
    const check = checkSolve(run.level, gates, dts, now);
    if (!check.ok) {
      // Resend the same level so the client starts it again.
      run.level.shownAt = now;
      return this.sendLevel(conn, run, 0);
    }
    run.score += check.points;
    run.level = makeLevel(level + 1, now);
    this.sendLevel(conn, run, check.points);
  }

  /** Ends a run and saves the score straight away; only a new personal best changes anything. */
  private endRun(uid: string): void {
    const run = this.runs.get(uid);
    if (!run) return;
    clearTimeout(run.timer);
    this.runs.delete(uid);
    const { best, newBest } = this.db.recordGateDash(uid, run.score);
    if (newBest) this.board.at = 0;
    const conn = this.byUid.get(uid);
    if (conn) this.send(conn, { t: 'gdEnd', score: run.score, best, newBest });
  }

  private sendLeaderboard(conn: Conn, uid: string): void {
    const now = Date.now();
    if (now - this.board.at >= TUNABLES.leaderboardRefreshMs) this.board = { top: this.db.topTotals(10), at: now };
    const top: LeaderRow[] = this.board.top.map((e, i) => ({ rank: i + 1, ...e }));
    const mine = this.db.rankOf(uid);
    const user = this.db.getUser(uid);
    const me = mine && user?.name ? { rank: mine.rank, name: user.name, p0: user.p0 ?? 50, total: mine.total } : null;
    this.send(conn, { t: 'leaderboard', top, me, total: this.db.countRanked() });
  }

  private onClaimName(conn: Conn, uid: string, raw: string): void {
    if (this.db.getUser(uid)?.name) return this.send(conn, { t: 'nameResult', ok: false, reason: 'You already have a name.' });
    const check = checkName(raw, config.reservedNames);
    if (!check.ok) return this.send(conn, { t: 'nameResult', ok: false, reason: check.reason });
    const r = this.db.claimName(uid, check.name, check.norm);
    if (r === 'ok') return this.send(conn, { t: 'nameResult', ok: true, name: check.name });
    const reason = r === 'taken' ? 'That name is already taken. Please try another one!' : 'You already have a name.';
    this.send(conn, { t: 'nameResult', ok: false, reason });
  }

  private onSetBird(conn: Conn, uid: string, p0: number): void {
    const user = this.db.getUser(uid);
    if (!user?.name) return this.send(conn, { t: 'birdResult', ok: false, reason: 'Choose a name first.' });
    if (this.runs.has(uid) || this.ravens.inMatch(uid)) return this.send(conn, { t: 'birdResult', ok: false, reason: 'You can change your bird after the game.' });
    const now = Date.now();
    const wait = user.bird_changed_at === null ? 0 : user.bird_changed_at + TUNABLES.avatarChangeIntervalMs - now;
    if (wait > 0) {
      return this.send(conn, { t: 'birdResult', ok: false, reason: 'Your bird needs a short rest before changing again.', retryInMs: wait });
    }
    this.db.setBird(uid, p0, now);
    this.send(conn, { t: 'birdResult', ok: true, p0 });
    this.hub.updateBird(uid, p0);
  }

  private onJoinHub(conn: Conn, uid: string): void {
    const user = this.db.getUser(uid);
    if (!user?.name || user.p0 === null) return this.send(conn, { t: 'error', msg: 'Finish your bird first.' });
    if (!this.hub.has(uid) && this.hub.size >= TUNABLES.hub.capacity) return this.kick(conn, 'full');
    this.hub.add(conn, uid, user.name, user.p0);
  }
}
