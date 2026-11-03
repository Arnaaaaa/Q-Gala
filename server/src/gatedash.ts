import { GATES, minGates, QSTATES, runGates, type Gate, type QState } from '../../shared/gates.ts';
import { TUNABLES } from '../../shared/tunables.ts';

const G = TUNABLES.gateDash;

export type Level = { level: number; start: QState; target: QState; min: number; gates: Gate[]; shownAt: number };

// With all of X, H and Z every state is at most 2 gates away (they join the four
// states in a ring). Three-gate levels therefore allow only two gates, e.g. H and Z
// turn |0⟩ into |1⟩ only as H Z H.
const THREE_GATE_SETS: Gate[][] = [['H', 'Z'], ['X', 'H']];

function pick<T>(items: T[], rand: () => number): T {
  return items[Math.floor(rand() * items.length)];
}

function pairsAt(dist: number, gates: readonly Gate[]): [QState, QState][] {
  const pairs: [QState, QState][] = [];
  for (const a of QSTATES) for (const b of QSTATES) if (minGates(a, b, gates) === dist) pairs.push([a, b]);
  return pairs;
}

/** Levels 1–3 need one gate, 4–7 up to two, 8 onward up to three. */
export function makeLevel(level: number, now: number, rand = Math.random): Level {
  if (level >= 8 && rand() < G.threeGateShare) {
    const gates = pick(THREE_GATE_SETS, rand);
    const [start, target] = pick(pairsAt(3, gates), rand);
    return { level, start, target, min: 3, gates, shownAt: now };
  }
  const want = level <= 3 ? 1 : rand() < (level <= 7 ? 0.6 : 0.85) ? 2 : 1;
  const [start, target] = pick(pairsAt(want, GATES), rand);
  return { level, start, target, min: want, gates: [...GATES], shownAt: now };
}

export type SolveCheck = { ok: true; points: number } | { ok: false; why: string };

/** Replays the submitted gates and checks the tap timing is humanly possible. */
export function checkSolve(lv: Level, gates: Gate[], dts: number[], now: number): SolveCheck {
  if (gates.length === 0 || gates.length !== dts.length || gates.length > G.maxGates) return { ok: false, why: 'shape' };
  if (gates.some((g) => !lv.gates.includes(g))) return { ok: false, why: 'locked gate' };
  if (runGates(lv.start, gates) !== lv.target) return { ok: false, why: 'wrong state' };
  if (dts.some((d) => d < G.minTapGapMs)) return { ok: false, why: 'too fast' };
  const claimed = dts.reduce((a, b) => a + b, 0);
  if (claimed > now - lv.shownAt + G.timingSlackMs) return { ok: false, why: 'timing' };
  return { ok: true, points: G.pointsPerLevel + (gates.length === lv.min ? G.minGatesBonus : 0) };
}

export type Run = { score: number; level: Level; endsAt: number; timer: NodeJS.Timeout };
