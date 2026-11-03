// Ravens and Robins calibration (spec D7). Simulates many rounds with the tunables
// in shared/tunables.ts and prints detection and win rates.
// Usage: node tools/calibrate.ts [rounds=100000]
import type { Wind } from '../../shared/protocol.ts';
import { TUNABLES } from '../../shared/tunables.ts';
import { botTrusts, countDisagree, fly, forecastFor, score, type Interception } from '../src/ravens.ts';

const R = TUNABLES.rr;
const N = Number(process.argv[2] ?? 100_000);
const rand = Math.random;
const wind = (): Wind => (rand() < 0.5 ? 'A' : 'B');

function round(intercepts: number, storm: number) {
  const l = { bits: Array.from({ length: R.notes }, () => (rand() < 0.5 ? 0 : 1) as 0 | 1), senderWinds: Array.from({ length: R.notes }, wind) };
  const notes = Array.from({ length: R.notes }, (_, i) => i).sort(() => rand() - 0.5).slice(0, intercepts);
  const raven: Interception = new Map(notes.map((i) => [i, wind()]));
  const f = fly(l, Array.from({ length: R.notes }, wind), raven, storm, rand);
  const k = Math.min(R.sample.default, f.kept.length);
  const sample = f.kept.slice().sort(() => rand() - 0.5).slice(0, k);
  const disagree = countDisagree(sample, l.bits, f.received);
  const verdict = botTrusts(disagree, k, forecastFor(storm)) ? 'trust' : 'abort';
  return { disagree, kept: f.kept.length, s: score(verdict, f.kept, sample, raven, l) };
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const randomStorm = () => R.storms[Math.floor(rand() * R.storms.length)];

console.log(`Ravens and Robins calibration, ${N} rounds per row, sample ${R.sample.default} of kept notes\n`);
console.log('Intercepts | storm      | ≥1 checked disagreement | bot Receiver aborts | Raven out-scores Robins | avg kept');
for (const n of [0, 4, 8, 16]) {
  for (const [label, storm] of [['none', () => 0], ['random', randomStorm]] as const) {
    let detect = 0, aborts = 0, ravenWins = 0, kept = 0;
    for (let i = 0; i < N; i++) {
      const r = round(n, storm());
      if (r.disagree > 0) detect++;
      if (r.s.outcome !== 'trusted') aborts++;
      if (r.s.raven > r.s.robin) ravenWins++;
      kept += r.kept;
    }
    console.log(`${String(n).padStart(10)} | ${label.padEnd(10)} | ${pct(detect / N).padStart(23)} | ${pct(aborts / N).padStart(19)} | ${pct(ravenWins / N).padStart(23)} | ${(kept / N).toFixed(1)}`);
  }
}

// Practice-bot Raven (0..aggression notes) against the bot Receiver rule.
let robin = 0, raven = 0, ravenWins = 0;
for (let i = 0; i < N; i++) {
  const r = round(Math.floor(rand() * (R.botRavenAggression + 1)), randomStorm());
  robin += r.s.robin;
  raven += r.s.raven;
  if (r.s.raven > r.s.robin) ravenWins++;
}
console.log(`\nBot vs bot: Robin avg ${(robin / N).toFixed(2)} pts/round, Raven avg ${(raven / N).toFixed(2)} pts/round, Raven out-scores ${pct(ravenWins / N)} of rounds`);
