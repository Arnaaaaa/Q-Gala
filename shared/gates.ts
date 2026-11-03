// Gate Dash rules. Global phase is ignored because it cannot be observed.
export const QSTATES = ['0', '1', '+', '-'] as const;
export type QState = (typeof QSTATES)[number];
export const GATES = ['X', 'H', 'Z'] as const;
export type Gate = (typeof GATES)[number];

const TABLE: Record<Gate, Record<QState, QState>> = {
  X: { '0': '1', '1': '0', '+': '+', '-': '-' },
  H: { '0': '+', '1': '-', '+': '0', '-': '1' },
  Z: { '0': '0', '1': '1', '+': '-', '-': '+' },
};

export const applyGate = (s: QState, g: Gate): QState => TABLE[g][s];

export const runGates = (s: QState, gates: readonly Gate[]): QState => gates.reduce(applyGate, s);

/** Fewest gates from `allowed` turning `from` into `to` (breadth-first search over the four states). */
export function minGates(from: QState, to: QState, allowed: readonly Gate[] = GATES): number {
  let frontier: QState[] = [from];
  const seen = new Set<QState>(frontier);
  for (let d = 0; frontier.length; d++) {
    if (frontier.includes(to)) return d;
    const next: QState[] = [];
    for (const s of frontier) for (const g of allowed) {
      const n = applyGate(s, g);
      if (!seen.has(n)) (seen.add(n), next.push(n));
    }
    frontier = next;
  }
  return Infinity;
}

export const stateLabel = (s: QState) => (s === '-' ? '|−⟩' : `|${s}⟩`);
