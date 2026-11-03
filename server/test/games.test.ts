import assert from 'node:assert/strict';
import test from 'node:test';
import { applyGate, GATES, minGates, QSTATES, runGates, type Gate } from '../../shared/gates.ts';
import { Db } from '../src/db.ts';
import { nodeSqlite } from '../src/sqlite-node.ts';
import { checkSolve, makeLevel } from '../src/gatedash.ts';
import { parseClientMsg } from '../src/validate.ts';

test('gate table matches the spec', () => {
  assert.deepEqual(QSTATES.map((s) => applyGate(s, 'X')), ['1', '0', '+', '-']);
  assert.deepEqual(QSTATES.map((s) => applyGate(s, 'H')), ['+', '-', '0', '1']);
  assert.deepEqual(QSTATES.map((s) => applyGate(s, 'Z')), ['0', '1', '-', '+']);
});

/** Shortest gate list by brute force, independent of minGates. */
function solve(from: (typeof QSTATES)[number], to: (typeof QSTATES)[number], allowed: readonly Gate[]): Gate[] | null {
  let seqs: Gate[][] = [[]];
  for (let len = 1; len <= 3; len++) {
    seqs = seqs.flatMap((s) => allowed.map((g) => [...s, g]));
    const hit = seqs.find((s) => runGates(from, s) === to);
    if (hit) return hit;
  }
  return null;
}

test('every generated level is solvable within its gate count, and start differs from target', () => {
  const threes = new Set<string>();
  for (let level = 1; level <= 30; level++) {
    for (let i = 0; i < 200; i++) {
      const lv = makeLevel(level, 0);
      assert.notEqual(lv.start, lv.target);
      const s = solve(lv.start, lv.target, lv.gates);
      assert.ok(s && s.length === lv.min && minGates(lv.start, lv.target, lv.gates) === lv.min);
      if (level <= 3) assert.equal(lv.min, 1);
      if (level <= 7) assert.ok(lv.min <= 2 && lv.gates.length === 3);
      assert.ok(lv.min <= 3);
      if (lv.min === 3) threes.add(`${lv.gates.join('')}:${lv.start}>${lv.target}`);
    }
  }
  // Level 8+ really produces 3-gate puzzles, e.g. only H and Z: |0⟩ → |1⟩ is H Z H.
  assert.ok(threes.has('HZ:0>1') && threes.has('XH:+>-'), [...threes].join(' '));
});

test('solve checks: replay, timing, bonus', () => {
  const lv = { level: 1, start: '0' as const, target: '+' as const, min: 1, gates: [...GATES], shownAt: 0 };
  const locked = { level: 9, start: '0' as const, target: '1' as const, min: 3, gates: ['H', 'Z'] as Gate[], shownAt: 0 };
  assert.deepEqual(checkSolve(locked, ['H', 'Z', 'H'], [300, 300, 300], 2000), { ok: true, points: 15 });
  assert.equal(checkSolve(locked, ['X'], [300], 2000).ok, false); // X is locked on this level
  assert.deepEqual(checkSolve(lv, ['H'], [400], 1000), { ok: true, points: 15 });
  assert.deepEqual(checkSolve(lv, ['X', 'X', 'H'], [300, 300, 300], 2000), { ok: true, points: 10 });
  assert.equal(checkSolve(lv, ['X'], [400], 1000).ok, false); // wrong state
  assert.equal(checkSolve(lv, ['X', 'X', 'H'], [300, 50, 300], 2000).ok, false); // too fast
  assert.equal(checkSolve(lv, ['H'], [9000], 1000).ok, false); // claims more time than passed
  assert.equal(parseClientMsg({ t: 'gdSolve', level: 1, gates: ['Y'], dts: [300] }), null);
  assert.equal(parseClientMsg({ t: 'say', p: 25 }), null);
  assert.deepEqual(parseClientMsg({ t: 'say', p: 24 }), { t: 'say', p: 24 });
  assert.equal(parseClientMsg({ t: 'emote', e: 'dance' }), null);
});

test('leaderboard: only improvements count, ties go to the earlier score, own rank outside top 10', () => {
  const db = new Db(nodeSqlite(':memory:'));
  for (let i = 0; i < 15; i++) {
    const id = `u${i}`;
    db.upsertLogin(id, 's', false);
    db.claimName(id, `Player ${'abcdefghijklmno'[i]}`, `player${'abcdefghijklmno'[i]}`);
    db.setBird(id, 50);
    db.recordGateDash(id, 100 - i * 5, 1000 + i);
  }
  db.upsertLogin('test', 's', true);
  db.claimName('test', 'Organizer Test', 'organizertest');
  db.recordGateDash('test', 999);

  assert.equal(db.recordGateDash('u0', 10).newBest, false);
  assert.equal(db.getUser('u0')!.gd_best, 100);
  const top = db.topTotals(10);
  assert.equal(top.length, 10);
  assert.ok(!top.some((r) => r.name === 'Organizer Test'), 'test accounts never ranked');
  assert.deepEqual(db.rankOf('u14'), { rank: 15, total: 30 });
  assert.equal(db.rankOf('test'), null);

  // u14 ties u13 at 35 later than u13, so ranks just behind it.
  db.recordGateDash('u14', 35, 5000);
  assert.equal(db.rankOf('u14')!.rank, 15);
  assert.equal(db.rankOf('u13')!.rank, 14);
  db.close();
});
