import crypto from 'node:crypto';
import type { BirdDTO, ServerMsg } from '../../shared/protocol.ts';
import { TUNABLES } from '../../shared/tunables.ts';
import { isWalkable, posAt, randomPlazaPoint, type Motion } from '../../shared/map.ts';

type Send<C> = (conn: C, msg: ServerMsg) => void;
type Kick<C> = (conn: C, code: 'idle') => void;

type HubBird<C> = Motion & {
  pid: string;
  uid: string;
  conn: C;
  name: string;
  p0: number;
  lastActive: number;
  idle: boolean;
  visible: Set<HubBird<C>>; // birds this player receives events for
  viewers: Set<HubBird<C>>; // players receiving events for this bird
};

const H = TUNABLES.hub;

/**
 * The Aviary. The server owns every position: clients send a destination,
 * the server validates it and broadcasts the walk to nearby players only.
 */
export class Hub<C> {
  private birds = new Map<string, HubBird<C>>();
  private timers: NodeJS.Timeout[] = [];
  private lastOnline = -1;
  private send: Send<C>;
  private kick: Kick<C>;

  constructor(send: Send<C>, kick: Kick<C>, autoTick = true) {
    this.send = send;
    this.kick = kick;
    if (autoTick) {
      this.timers.push(
        setInterval(() => this.tick(Date.now()), H.tickMs),
        setInterval(() => this.sync(Date.now()), H.syncMs),
        setInterval(() => this.broadcastOnline(), H.onlineMs),
      );
    }
  }

  get size(): number {
    return this.birds.size;
  }

  has(uid: string): boolean {
    return this.birds.has(uid);
  }

  add(conn: C, uid: string, name: string, p0: number, now = Date.now()): void {
    this.remove(uid);
    const p = randomPlazaPoint();
    const b: HubBird<C> = {
      pid: crypto.randomBytes(5).toString('hex'),
      uid, conn, name, p0,
      x0: p.x, y0: p.y, tx: p.x, ty: p.y, t0: now,
      lastActive: now, idle: false,
      visible: new Set(), viewers: new Set(),
    };
    this.birds.set(uid, b);
    this.send(conn, { t: 'hubState', you: this.dto(b, now), online: this.birds.size });
    this.refreshView(b, now);
  }

  remove(uid: string): void {
    const b = this.birds.get(uid);
    if (!b) return;
    this.birds.delete(uid);
    for (const v of b.viewers) {
      v.visible.delete(b);
      this.send(v.conn, { t: 'leave', id: b.pid });
    }
    for (const o of b.visible) o.viewers.delete(b);
  }

  move(uid: string, x: number, y: number, now = Date.now()): boolean {
    const b = this.birds.get(uid);
    if (!b || !isWalkable(x, y)) return false;
    const p = posAt(b, now, H.walkSpeed);
    Object.assign(b, { x0: p.x, y0: p.y, tx: x, ty: y, t0: now });
    this.touch(b, now);
    this.toSelfAndViewers(b, { t: 'moved', id: b.pid, x: Math.round(p.x), y: Math.round(p.y), tx: x, ty: y });
    return true;
  }

  /** Sends an event about this player's bird to them and to everyone who can see them. */
  announce(uid: string, make: (pid: string, p0: number) => ServerMsg, now = Date.now()): boolean {
    const b = this.birds.get(uid);
    if (!b) return false;
    this.touch(b, now);
    this.toSelfAndViewers(b, make(b.pid, b.p0));
    return true;
  }

  updateBird(uid: string, p0: number): void {
    const b = this.birds.get(uid);
    if (!b) return;
    b.p0 = p0;
    this.toSelfAndViewers(b, { t: 'birdChanged', id: b.pid, p0 });
  }

  /** Recomputes who sees whom, and handles idle fade and idle disconnect. */
  tick(now: number): void {
    const toKick: C[] = [];
    for (const b of this.birds.values()) {
      const quiet = now - b.lastActive;
      if (quiet >= H.idleKickMs) toKick.push(b.conn);
      else if (quiet >= H.idleFadeMs && !b.idle) {
        b.idle = true;
        this.toSelfAndViewers(b, { t: 'idle', id: b.pid, idle: true });
      }
    }
    for (const c of toKick) this.kick(c, 'idle');

    const pos = new Map<HubBird<C>, { x: number; y: number }>();
    for (const b of this.birds.values()) pos.set(b, posAt(b, now, H.walkSpeed));
    for (const b of this.birds.values()) this.refreshView(b, now, pos);
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
  }

  private refreshView(v: HubBird<C>, now: number, pos?: Map<HubBird<C>, { x: number; y: number }>): void {
    const at = (b: HubBird<C>) => pos?.get(b) ?? posAt(b, now, H.walkSpeed);
    const me = at(v);
    const r2 = H.viewRadius * H.viewRadius;
    let near: { b: HubBird<C>; d2: number }[] = [];
    for (const o of this.birds.values()) {
      if (o === v) continue;
      const p = at(o);
      const d2 = (p.x - me.x) ** 2 + (p.y - me.y) ** 2;
      if (d2 <= r2) near.push({ b: o, d2 });
    }
    if (near.length > H.maxVisible - 1) near = near.sort((a, b) => a.d2 - b.d2).slice(0, H.maxVisible - 1);
    const next = new Set(near.map((n) => n.b));
    for (const o of v.visible) {
      if (next.has(o)) continue;
      v.visible.delete(o);
      o.viewers.delete(v);
      this.send(v.conn, { t: 'leave', id: o.pid });
    }
    for (const o of next) {
      if (v.visible.has(o)) continue;
      v.visible.add(o);
      o.viewers.add(v);
      this.send(v.conn, { t: 'enter', bird: this.dto(o, now) });
    }
  }

  private sync(now: number): void {
    for (const v of this.birds.values()) {
      const b: [string, number, number, number, number][] = [];
      for (const o of [v, ...v.visible]) {
        const p = posAt(o, now, H.walkSpeed);
        b.push([o.pid, Math.round(p.x), Math.round(p.y), o.tx, o.ty]);
      }
      this.send(v.conn, { t: 'sync', b });
    }
  }

  private broadcastOnline(): void {
    if (this.birds.size === this.lastOnline) return;
    this.lastOnline = this.birds.size;
    for (const b of this.birds.values()) this.send(b.conn, { t: 'online', n: this.lastOnline });
  }

  private touch(b: HubBird<C>, now: number): void {
    b.lastActive = now;
    if (b.idle) {
      b.idle = false;
      this.toSelfAndViewers(b, { t: 'idle', id: b.pid, idle: false });
    }
  }

  private toSelfAndViewers(b: HubBird<C>, msg: ServerMsg): void {
    this.send(b.conn, msg);
    for (const v of b.viewers) this.send(v.conn, msg);
  }

  private dto(b: HubBird<C>, now: number): BirdDTO {
    const p = posAt(b, now, H.walkSpeed);
    return { id: b.pid, name: b.name, p0: b.p0, x: Math.round(p.x), y: Math.round(p.y), tx: b.tx, ty: b.ty, idle: b.idle };
  }
}
