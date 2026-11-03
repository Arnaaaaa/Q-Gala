import type { Bit, ClientMsg, RrPhase, RrReaction, RrRole, RrSeat, ServerMsg, Wind } from '../../shared/protocol.ts';
import { TUNABLES } from '../../shared/tunables.ts';

const R = TUNABLES.rr;
type Rand = () => number;

const randBit = (rand: Rand): Bit => (rand() < 0.5 ? 0 : 1);
const randWind = (rand: Rand): Wind => (rand() < 0.5 ? 'A' : 'B');
const fill = <T>(n: number, f: () => T): T[] => Array.from({ length: n }, f);

function sampleOf<T>(items: T[], k: number, rand: Rand): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

// ---------- Pure round rules (also used by the calibration tool and tests) ----------

export type Launch = { bits: Bit[]; senderWinds: Wind[] };
export type Interception = Map<number, Wind>; // note → Raven's wind guess

export type Flight = { received: Bit[]; reads: Map<number, Bit>; kept: number[] };

/** Spec D7 step 3: the Raven's peeks, the Receiver's measurements, then the storm. */
export function fly(l: Launch, receiverWinds: Wind[], raven: Interception, storm: number, rand: Rand): Flight {
  const reads = new Map<number, Bit>();
  const received: Bit[] = [];
  const kept: number[] = [];
  for (let i = 0; i < l.bits.length; i++) {
    const guess = raven.get(i);
    const wrongPeek = guess !== undefined && guess !== l.senderWinds[i];
    if (guess !== undefined) reads.set(i, wrongPeek ? randBit(rand) : l.bits[i]);
    let bit: Bit;
    if (receiverWinds[i] === l.senderWinds[i]) {
      bit = wrongPeek ? randBit(rand) : l.bits[i];
      kept.push(i);
    } else bit = randBit(rand);
    if (rand() < storm) bit = (1 - bit) as Bit;
    received.push(bit);
  }
  return { received, reads, kept };
}

export function forecastFor(storm: number): [number, number] {
  const pct = Math.round(storm * 100);
  return [Math.max(0, pct - R.forecastHalfWidthPct), pct + R.forecastHalfWidthPct];
}

export function countDisagree(sample: number[], bits: Bit[], received: Bit[]): number {
  return sample.filter((i) => bits[i] !== received[i]).length;
}

/** Practice-bot Receiver: aborts when checked errors exceed the forecast top by more than the margin. */
export function botTrusts(disagree: number, k: number, forecast: [number, number]): boolean {
  return k === 0 || (disagree / k) * 100 <= forecast[1] + R.botAbortMarginPct;
}

export type Scored = { outcome: 'trusted' | 'foiled' | 'falseAlarm'; robin: number; raven: number; key: number[]; learned: number[] };

/** Spec D7 scoring for one round. */
export function score(verdict: 'trust' | 'abort', kept: number[], sample: number[], raven: Interception, l: Launch, pts = R.points): Scored {
  const sampled = new Set(sample);
  const key = kept.filter((i) => !sampled.has(i));
  const learned = key.filter((i) => raven.get(i) === l.senderWinds[i]);
  if (verdict === 'trust') {
    return { outcome: 'trusted', robin: (key.length - learned.length) * pts.robinPerSafeBit, raven: learned.length * pts.ravenPerLearnedBit, key, learned };
  }
  if (raven.size > 0) return { outcome: 'foiled', robin: pts.spyFoiled, raven: 0, key, learned };
  return { outcome: 'falseAlarm', robin: 0, raven: pts.bluff, key, learned };
}

export function botInterception(rand: Rand, aggression = R.botRavenAggression): Interception {
  const n = Math.floor(rand() * (Math.min(aggression, R.maxIntercepts) + 1));
  const notes = sampleOf(Array.from({ length: R.notes }, (_, i) => i), n, rand);
  return new Map(notes.map((i) => [i, randWind(rand)]));
}

// ---------- A match: three players, three rounds, roles rotate ----------

export type MatchIO = {
  send(uid: string, msg: ServerMsg): void;
  save(uid: string, score: number): { best: number; newBest: boolean };
  ended(m: Match): void;
};

export type Player = { uid: string; name: string; p0: number };
type Seat = RrSeat & { uid: string | null };

const BOT_NAMES = ['Practice bot Wren', 'Practice bot Finch', 'Practice bot Lark'];

type Round = {
  n: number;
  roles: Record<RrRole, number>;
  storm: number;
  launch: Launch;
  receiverWinds: Wind[];
  ravenDefaults: Wind[];
  raven: Interception;
  flight: Flight | null;
  sample: number[];
  forecast: [number, number];
  disagree: number;
  receiverDone: boolean;
  ravenDone: boolean;
  reacted: boolean;
};

export class Match {
  readonly seats: Seat[];
  private io: MatchIO;
  private rand: Rand;
  private round: Round | null = null;
  private phase: RrPhase | 'over' = 'launch';
  private timer: NodeJS.Timeout | undefined;
  private botTimers: NodeJS.Timeout[] = [];

  constructor(players: Player[], io: MatchIO, rand: Rand = Math.random) {
    this.io = io;
    this.rand = rand;
    let b = 0;
    this.seats = [0, 1, 2].map((i) => {
      const p = players[i];
      return p
        ? { uid: p.uid, name: p.name, p0: p.p0, bot: false, score: 0 }
        : { uid: null, name: BOT_NAMES[b++], p0: Math.round(rand() * 20) * 5, bot: true, score: 0 };
    });
  }

  get humans(): string[] {
    return this.seats.filter((s) => !s.bot && s.uid).map((s) => s.uid!);
  }

  start(): void {
    const seats = this.publicSeats();
    this.seats.forEach((s, i) => s.uid && this.io.send(s.uid, { t: 'rrMatch', seats, you: i, rounds: R.rounds }));
    this.startRound(0);
  }

  /** A player left or disconnected: a practice bot takes the seat and the match goes on. */
  leave(uid: string): void {
    const seat = this.seats.find((s) => s.uid === uid);
    if (!seat) return;
    seat.uid = null;
    seat.bot = true;
    seat.name = `${seat.name} (bot)`;
    if (this.humans.length === 0) return this.stop();
    this.broadcast({ t: 'rrSeats', seats: this.publicSeats() });
    this.runBots();
  }

  stop(): void {
    this.phase = 'over';
    clearTimeout(this.timer);
    for (const t of this.botTimers) clearTimeout(t);
    this.io.ended(this);
  }

  handle(uid: string, msg: ClientMsg): void {
    const r = this.round;
    const seat = this.seats.findIndex((s) => s.uid === uid);
    if (!r || seat < 0) return;
    const role = this.roleOf(seat);
    switch (msg.t) {
      case 'rrWinds':
        if (this.phase !== 'choose' || role !== 'receiver' || r.receiverDone || msg.winds.length !== R.notes) return;
        r.receiverWinds = msg.winds;
        if (msg.done) (r.receiverDone = true), this.maybeEndChoose();
        return;
      case 'rrIntercept': {
        if (this.phase !== 'choose' || role !== 'raven' || r.ravenDone) return;
        const notes = [...new Set(msg.notes)];
        if (notes.length > R.maxIntercepts || notes.length !== msg.guesses.length || notes.some((i) => i < 0 || i >= R.notes)) return;
        r.raven = new Map(notes.map((i, j) => [i, msg.guesses[j]]));
        if (msg.done) (r.ravenDone = true), this.maybeEndChoose();
        return;
      }
      case 'rrSample':
        if (this.phase === 'compare' && role === 'sender') this.reveal(msg.k);
        return;
      case 'rrReact':
        if (this.phase === 'verdict' && role === 'sender') this.react(msg.r);
        return;
      case 'rrVerdict':
        if (this.phase === 'verdict' && role === 'receiver') this.resolve(msg.v);
        return;
    }
  }

  // ---- round flow ----

  private startRound(n: number): void {
    const rand = this.rand;
    const roles = { sender: n % 3, receiver: (n + 1) % 3, raven: (n + 2) % 3 };
    this.round = {
      n,
      roles,
      storm: R.storms[Math.floor(rand() * R.storms.length)],
      launch: { bits: fill(R.notes, () => randBit(rand)), senderWinds: fill(R.notes, () => randWind(rand)) },
      receiverWinds: fill(R.notes, () => randWind(rand)),
      ravenDefaults: fill(R.notes, () => randWind(rand)),
      raven: new Map(),
      flight: null,
      sample: [],
      forecast: [0, 0],
      disagree: 0,
      receiverDone: false,
      ravenDone: false,
      reacted: false,
    };
    this.seats.forEach((s, i) => s.uid && this.io.send(s.uid, { t: 'rrRound', round: n + 1, roles, you: this.roleOf(i) }));
    this.setPhase('launch', R.launchMs, () => this.startChoose());
    const sender = this.uidOf('sender');
    if (sender) this.io.send(sender, { t: 'rrSecret', bits: this.round.launch.bits, winds: this.round.launch.senderWinds });
  }

  private startChoose(): void {
    const r = this.round!;
    const receiver = this.uidOf('receiver');
    const raven = this.uidOf('raven');
    if (receiver) this.io.send(receiver, { t: 'rrDefaults', winds: r.receiverWinds });
    if (raven) this.io.send(raven, { t: 'rrDefaults', winds: r.ravenDefaults });
    this.setPhase('choose', R.chooseMs, () => this.startCompare());
  }

  private maybeEndChoose(): void {
    const r = this.round!;
    if (this.phase === 'choose' && r.receiverDone && r.ravenDone) this.startCompare();
  }

  private startCompare(): void {
    const r = this.round!;
    r.flight = fly(r.launch, r.receiverWinds, r.raven, r.storm, this.rand);
    const raven = this.uidOf('raven');
    if (raven) this.io.send(raven, { t: 'rrRead', reads: [...r.flight.reads] });
    this.broadcast({ t: 'rrCompare', senderWinds: r.launch.senderWinds, receiverWinds: r.receiverWinds, kept: r.flight.kept });
    this.setPhase('compare', R.compareMs, () => this.reveal(R.sample.default));
  }

  private reveal(k: number): void {
    const r = this.round!;
    const f = r.flight!;
    const size = Math.min(f.kept.length, Math.max(R.sample.min, Math.min(R.sample.max, Math.round(k))));
    r.sample = sampleOf(f.kept, size, this.rand).sort((a, b) => a - b);
    r.forecast = forecastFor(r.storm);
    r.disagree = countDisagree(r.sample, r.launch.bits, f.received);
    this.broadcast({
      t: 'rrSampled',
      notes: r.sample,
      senderBits: r.sample.map((i) => r.launch.bits[i]),
      receiverBits: r.sample.map((i) => f.received[i]),
      disagree: r.disagree,
      forecast: r.forecast,
    });
    // No answer counts as Abort.
    this.setPhase('verdict', R.verdictMs, () => this.resolve('abort'));
  }

  private react(reaction: RrReaction): void {
    const r = this.round!;
    if (r.reacted) return;
    r.reacted = true;
    const receiver = this.uidOf('receiver');
    if (receiver) this.io.send(receiver, { t: 'rrReaction', r: reaction });
  }

  private resolve(verdict: 'trust' | 'abort'): void {
    const r = this.round!;
    const s = score(verdict, r.flight!.kept, r.sample, r.raven, r.launch);
    const points = [0, 0, 0];
    points[r.roles.sender] = points[r.roles.receiver] = s.robin;
    points[r.roles.raven] = s.raven;
    this.seats.forEach((seat, i) => (seat.score += points[i]));
    this.broadcast({ t: 'rrResult', verdict, outcome: s.outcome, intercepted: [...r.raven.keys()].sort((a, b) => a - b), learned: s.learned, key: s.key, points });
    this.broadcast({ t: 'rrSeats', seats: this.publicSeats() });
    this.setPhase('result', R.resultMs, () => (r.n + 1 < R.rounds ? this.startRound(r.n + 1) : this.finish()));
  }

  /** Saves every human's match score as soon as the match ends. */
  private finish(): void {
    const seats = this.publicSeats();
    this.seats.forEach((s, i) => {
      if (!s.uid) return;
      const { best, newBest } = this.io.save(s.uid, s.score);
      this.io.send(s.uid, { t: 'rrEnd', seats, you: i, best, newBest });
    });
    this.stop();
  }

  // ---- helpers ----

  private setPhase(phase: RrPhase, ms: number, next: () => void): void {
    clearTimeout(this.timer);
    for (const t of this.botTimers) clearTimeout(t);
    this.botTimers = [];
    this.phase = phase;
    this.broadcast({ t: 'rrPhase', phase, msLeft: ms });
    this.timer = setTimeout(() => this.phase === phase && next(), ms);
    this.runBots();
  }

  /** Schedules whatever the bot-held seats still need to do in this phase. */
  private runBots(): void {
    const r = this.round;
    if (!r) return;
    const isBot = (role: RrRole) => this.seats[r.roles[role]].bot;
    const later = (f: () => void) => {
      const phase = this.phase;
      this.botTimers.push(setTimeout(() => this.phase === phase && f(), 1200 + this.rand() * 2500));
    };
    if (this.phase === 'choose') {
      if (isBot('receiver') && !r.receiverDone) later(() => ((r.receiverDone = true), this.maybeEndChoose()));
      if (isBot('raven') && !r.ravenDone) later(() => ((r.raven = botInterception(this.rand)), (r.ravenDone = true), this.maybeEndChoose()));
    } else if (this.phase === 'compare' && isBot('sender')) later(() => this.reveal(R.sample.default));
    else if (this.phase === 'verdict') {
      const trusts = botTrusts(r.disagree, r.sample.length, r.forecast);
      if (isBot('sender') && !r.reacted) later(() => this.react(trusts ? 'fine' : 'raven'));
      if (isBot('receiver')) later(() => this.resolve(trusts ? 'trust' : 'abort'));
    }
  }

  private roleOf(seat: number): RrRole {
    const r = this.round!;
    return seat === r.roles.sender ? 'sender' : seat === r.roles.receiver ? 'receiver' : 'raven';
  }

  private uidOf(role: RrRole): string | null {
    return this.seats[this.round!.roles[role]].uid;
  }

  private publicSeats(): RrSeat[] {
    return this.seats.map(({ name, p0, bot, score }) => ({ name, p0, bot, score }));
  }

  private broadcast(msg: ServerMsg): void {
    for (const s of this.seats) if (s.uid) this.io.send(s.uid, msg);
  }
}

// ---------- Queue: trios form from waiting players; bots fill seats after a wait ----------

export class RavensLobby {
  private queue: (Player & { since: number })[] = [];
  private matches = new Map<string, Match>();
  private io: Omit<MatchIO, 'ended'>;
  private rand: Rand;
  private ticker: NodeJS.Timeout | undefined;

  constructor(io: Omit<MatchIO, 'ended'>, rand: Rand = Math.random, autoTick = true) {
    this.io = io;
    this.rand = rand;
    if (autoTick) this.ticker = setInterval(() => this.tick(Date.now()), 1000);
  }

  busy(uid: string): boolean {
    return this.matches.has(uid) || this.queue.some((q) => q.uid === uid);
  }

  inMatch(uid: string): boolean {
    return this.matches.has(uid);
  }

  join(p: Player, now = Date.now()): void {
    if (this.busy(p.uid)) return;
    this.queue.push({ ...p, since: now });
    this.io.send(p.uid, { t: 'rrQueued', botInMs: R.botWaitMs });
    this.tick(now);
  }

  leave(uid: string): void {
    this.queue = this.queue.filter((q) => q.uid !== uid);
    const m = this.matches.get(uid);
    this.matches.delete(uid);
    m?.leave(uid);
  }

  handle(uid: string, msg: ClientMsg): void {
    this.matches.get(uid)?.handle(uid, msg);
  }

  tick(now: number): void {
    while (this.queue.length >= 3) this.form(this.queue.splice(0, 3));
    if (this.queue.length && now - this.queue[0].since >= R.botWaitMs) this.form(this.queue.splice(0, this.queue.length));
  }

  stop(): void {
    clearInterval(this.ticker);
    for (const m of new Set(this.matches.values())) m.stop();
  }

  private form(players: Player[]): void {
    const m = new Match(players, { ...this.io, ended: (done) => this.ended(done) }, this.rand);
    for (const p of players) this.matches.set(p.uid, m);
    m.start();
  }

  private ended(m: Match): void {
    for (const [uid, mm] of this.matches) if (mm === m) this.matches.delete(uid);
  }
}
