import assert from 'node:assert/strict';
import test from 'node:test';
import type { ServerMsg, Wind } from '../../shared/protocol.ts';
import { TUNABLES } from '../../shared/tunables.ts';
import { botTrusts, countDisagree, fly, forecastFor, Match, RavensLobby, score, type Launch } from '../src/ravens.ts';

const R = TUNABLES.rr;

/** Small seeded PRNG so failures are reproducible. */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const launch = (rand: () => number): Launch => ({
  bits: Array.from({ length: R.notes }, () => (rand() < 0.5 ? 0 : 1)),
  senderWinds: Array.from({ length: R.notes }, () => (rand() < 0.5 ? 'A' : 'B')),
});
const winds = (rand: () => number): Wind[] => Array.from({ length: R.notes }, () => (rand() < 0.5 ? 'A' : 'B'));

test('no storm and no interception: a checked note never disagrees', () => {
  const rand = seeded(1);
  for (let i = 0; i < 2000; i++) {
    const l = launch(rand);
    const f = fly(l, winds(rand), new Map(), 0, rand);
    assert.equal(countDisagree(f.kept, l.bits, f.received), 0);
  }
});

test('the Raven reads true bits only with the right wind', () => {
  const rand = seeded(2);
  const l = launch(rand);
  const raven = new Map(l.senderWinds.map((w, i) => [i, w] as [number, Wind]));
  const f = fly(l, l.senderWinds, raven, 0, rand);
  for (const [i, b] of f.reads) assert.equal(b, l.bits[i]);
  assert.equal(f.kept.length, R.notes);
});

test('scoring follows the spec', () => {
  const l: Launch = { bits: [0, 1, 0, 1], senderWinds: ['A', 'A', 'B', 'B'] };
  const kept = [0, 1, 2, 3];
  const raven = new Map<number, Wind>([[1, 'A'], [2, 'A']]); // right wind on note 1, wrong on 2
  assert.deepEqual(score('trust', kept, [3], raven, l), { outcome: 'trusted', robin: 2, raven: 4, key: [0, 1, 2], learned: [1] });
  assert.equal(score('abort', kept, [3], raven, l).robin, 10);
  assert.equal(score('abort', kept, [3], raven, l).raven, 0);
  const none = score('abort', kept, [3], new Map(), l);
  assert.deepEqual([none.outcome, none.robin, none.raven], ['falseAlarm', 0, 5]);
  assert.deepEqual(forecastFor(0), [0, 3]);
  assert.deepEqual(forecastFor(0.06), [3, 9]);
  assert.equal(botTrusts(1, 6, [0, 3]), false); // 17% > 13%
  assert.equal(botTrusts(0, 6, [0, 3]), true);
});

type Inbox = Map<string, ServerMsg[]>;

function harness(rand: () => number) {
  const inbox: Inbox = new Map();
  const saved = new Map<string, number>();
  let ended = false;
  const io = {
    send: (uid: string, m: ServerMsg) => (inbox.get(uid) ?? inbox.set(uid, []).get(uid)!).push(m),
    save: (uid: string, s: number) => (saved.set(uid, s), { best: s, newBest: true }),
    ended: () => (ended = true),
  };
  return { inbox, saved, io, isEnded: () => ended, rand };
}

const PHASE_MS = R.launchMs + R.chooseMs + R.compareMs + R.verdictMs + R.resultMs;

/** Advances mock time in small steps so timers scheduled along the way also fire. */
function advance(t: { mock: { timers: { tick(ms: number): void } } }, ms: number): void {
  for (let left = ms; left > 0; left -= 250) t.mock.timers.tick(Math.min(250, left));
}

test('hidden values only reach the role allowed to see them, every round', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(seeded(4));
  const uids = ['a', 'b', 'c'];
  const m = new Match(uids.map((uid) => ({ uid, name: uid, p0: 50 })), h.io, h.rand);
  m.start();
  for (let round = 0; round < R.rounds; round++) {
    const sender = uids[round % 3], receiver = uids[(round + 1) % 3], raven = uids[(round + 2) % 3];
    // Raven intercepts a few notes during the choose phase so rrRead is produced.
    advance(t, R.launchMs + 1);
    m.handle(raven, { t: 'rrIntercept', notes: [0, 1, 2, 3], guesses: ['A', 'B', 'A', 'B'], done: true });
    m.handle(receiver, { t: 'rrWinds', winds: Array(R.notes).fill('A'), done: true });
    m.handle(sender, { t: 'rrSample', k: 6 });
    m.handle(sender, { t: 'rrReact', r: 'raven' });
    m.handle(raven, { t: 'rrVerdict', v: 'trust' }); // wrong role: ignored
    m.handle(receiver, { t: 'rrVerdict', v: 'abort' });

    const got = (uid: string, type: ServerMsg['t']) => h.inbox.get(uid)!.some((x) => x.t === type);
    assert.ok(got(sender, 'rrSecret') && !got(receiver, 'rrSecret') && !got(raven, 'rrSecret'), `round ${round}: secret`);
    assert.ok(got(raven, 'rrRead') && !got(sender, 'rrRead') && !got(receiver, 'rrRead'), `round ${round}: reads`);
    assert.ok(got(receiver, 'rrReaction') && !got(sender, 'rrReaction') && !got(raven, 'rrReaction'), `round ${round}: reaction`);
    assert.ok(!got(sender, 'rrDefaults'), `round ${round}: sender has no defaults`);
    for (const u of uids) assert.ok(got(u, 'rrCompare') && got(u, 'rrSampled') && got(u, 'rrResult'));
    // The Raven's reads only cover the notes she intercepted.
    const read = h.inbox.get(raven)!.find((x) => x.t === 'rrRead') as Extract<ServerMsg, { t: 'rrRead' }>;
    assert.deepEqual(read.reads.map(([i]) => i), [0, 1, 2, 3]);
    const result = h.inbox.get(sender)!.findLast((x) => x.t === 'rrResult') as Extract<ServerMsg, { t: 'rrResult' }>;
    assert.equal(result.outcome, 'foiled');
    for (const box of h.inbox.values()) box.length = 0;
    advance(t, R.resultMs + 1);
  }
  assert.ok(h.isEnded());
  // Every round was a foiled spy: each player was a Robin twice (10 each) and the Raven once (0).
  assert.deepEqual([...h.saved.values()], [20, 20, 20]);
});

test('one human with two practice bots completes a full match on timeouts', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(seeded(5));
  const m = new Match([{ uid: 'solo', name: 'Solo', p0: 50 }], h.io, h.rand);
  m.start();
  assert.equal(m.seats.filter((s) => s.bot).length, 2);
  for (let i = 0; i < R.rounds; i++) advance(t, PHASE_MS + 10);
  assert.ok(h.isEnded());
  assert.ok(h.saved.has('solo'));
  assert.ok(h.inbox.get('solo')!.some((x) => x.t === 'rrEnd'));
});

test('a disconnect hands the seat to a bot and the match continues', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(seeded(6));
  const m = new Match(['a', 'b', 'c'].map((uid) => ({ uid, name: uid, p0: 50 })), h.io, h.rand);
  m.start();
  advance(t, R.launchMs + 1);
  m.leave('b');
  assert.ok(m.seats[1].bot);
  for (let i = 0; i < R.rounds; i++) advance(t, PHASE_MS + 10);
  assert.ok(h.isEnded());
  assert.ok(h.saved.has('a') && h.saved.has('c') && !h.saved.has('b'));
});

test('lobby forms trios, and fills with bots after the wait', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(seeded(7));
  const lobby = new RavensLobby(h.io, h.rand, false);
  lobby.join({ uid: 'x', name: 'x', p0: 50 }, 0);
  assert.ok(lobby.busy('x') && !lobby.inMatch('x'));
  lobby.tick(R.botWaitMs - 1);
  assert.ok(!lobby.inMatch('x'));
  lobby.tick(R.botWaitMs);
  assert.ok(lobby.inMatch('x'));
  for (const u of ['p', 'q', 'r']) lobby.join({ uid: u, name: u, p0: 50 }, 0);
  assert.ok(['p', 'q', 'r'].every((u) => lobby.inMatch(u)));
  lobby.stop();
});
