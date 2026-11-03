import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeName, suggestName } from '../../shared/names.ts';
import { isWalkable, PLAZA, posAt } from '../../shared/map.ts';
import type { ServerMsg } from '../../shared/protocol.ts';
import { signSession, verifySession } from '../src/auth.ts';
import { Db } from '../src/db.ts';
import { nodeSqlite } from '../src/sqlite-node.ts';
import { Hub } from '../src/hub.ts';
import { checkName } from '../src/names.ts';
import { RateLimiter } from '../src/ratelimit.ts';
import { parseClientMsg } from '../src/validate.ts';

test('look-alike names normalize to the same key', () => {
  assert.equal(normalizeName('Arna'), normalizeName('arna'));
  assert.equal(normalizeName('Ar_na'), normalizeName('arna'));
  assert.equal(normalizeName('Ar na'), normalizeName('ARNA'));
  assert.equal(normalizeName('B0b'), normalizeName('bob'));
  assert.equal(normalizeName('l1l'), normalizeName('iil'));
});

test('name rules', () => {
  assert.equal(checkName('ab').ok, false);
  assert.equal(checkName('a'.repeat(17)).ok, false);
  assert.equal(checkName('bad<script>').ok, false);
  assert.equal(checkName('Admin').ok, false);
  assert.equal(checkName('a d m i n').ok, false);
  assert.equal(checkName('Qiskit Fan').ok, false);
  assert.equal(checkName('Moderator9').ok, false);
  assert.equal(checkName('Arnab', ['arnab']).ok, false);
  assert.equal(checkName('  Robin   Hood ').ok, true);
  const r = checkName('  Robin   Hood ');
  assert.ok(r.ok && r.name === 'Robin Hood');
  assert.equal(suggestName('🐦 Arna ✨'), 'Arna');
});

test('name claims are atomic and case/look-alike insensitive', () => {
  const db = new Db(nodeSqlite(':memory:'));
  for (const id of ['a', 'b', 'c']) db.upsertLogin(id, 's', false);
  assert.equal(db.claimName('a', 'Arna', normalizeName('Arna')), 'ok');
  assert.equal(db.claimName('b', 'arna', normalizeName('arna')), 'taken');
  assert.equal(db.claimName('c', 'Ar_na', normalizeName('Ar_na')), 'taken');
  assert.equal(db.claimName('a', 'Other', normalizeName('Other')), 'already');
  db.close();
});

test('session tokens: valid, tampered, expired', () => {
  const secret = 'x'.repeat(40);
  const tok = signSession({ uid: 'u', sid: 's', exp: Date.now() + 1000 }, secret);
  assert.deepEqual(verifySession(tok, secret)?.uid, 'u');
  assert.equal(verifySession(tok + 'x', secret), null);
  assert.equal(verifySession(tok, 'y'.repeat(40)), null);
  assert.equal(verifySession(tok, secret, Date.now() + 5000), null);
});

test('message validation drops bad shapes', () => {
  assert.equal(parseClientMsg({ t: 'nope' }), null);
  assert.equal(parseClientMsg({ t: 'setBird', p0: 33 }), null);
  assert.equal(parseClientMsg({ t: 'setBird', p0: 105 }), null);
  assert.deepEqual(parseClientMsg({ t: 'setBird', p0: 35, extra: 1 }), { t: 'setBird', p0: 35 });
  assert.equal(parseClientMsg({ t: 'move', x: NaN, y: 1 }), null);
  assert.equal(parseClientMsg([1]), null);
});

test('rate limiter enforces burst then refills', () => {
  const rl = new RateLimiter();
  const now = 1_000_000;
  let ok = 0;
  for (let i = 0; i < 20; i++) if (rl.allow('move', now)) ok++;
  assert.equal(ok, 6);
  assert.equal(rl.allow('move', now + 250), true);
  assert.equal(rl.allow('unknown', now), false);
});

test('motion interpolation', () => {
  const m = { x0: 0, y0: 0, tx: 100, ty: 0, t0: 0 };
  assert.deepEqual(posAt(m, 500, 100), { x: 50, y: 0 });
  assert.deepEqual(posAt(m, 5000, 100), { x: 100, y: 0 });
  assert.ok(isWalkable(PLAZA.x, PLAZA.y));
  assert.ok(!isWalkable(-10, 50));
});

test('hub: nearby birds see each other, far ones do not, invalid moves rejected', () => {
  const inbox = new Map<string, ServerMsg[]>();
  const hub = new Hub<string>((c, m) => inbox.get(c)!.push(m), () => {}, false);
  for (const c of ['a', 'b']) inbox.set(c, []);
  hub.add('a', 'a', 'Alpha', 50, 0);
  hub.add('b', 'b', 'Beta', 50, 0);
  hub.tick(0);
  assert.ok(inbox.get('a')!.some((m) => m.t === 'enter'));
  assert.equal(hub.move('a', -5, -5, 10), false);
  assert.equal(hub.move('a', PLAZA.x + 10, PLAZA.y, 10), true);
  assert.ok(inbox.get('b')!.some((m) => m.t === 'moved'));
  // Walk b far away; after arriving, a should get a leave.
  hub.move('b', 3100, 2100, 20);
  hub.tick(60_000);
  assert.ok(inbox.get('a')!.some((m) => m.t === 'leave'));
  hub.remove('a');
  hub.stop();
});
