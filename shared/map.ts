export const WORLD = { w: 3200, h: 2200 };
export const MARGIN = 60;
export const PLAZA = { x: 1600, y: 1100, r: 380 };

export type LandmarkId = 'flightDeck' | 'hall' | 'leaderboard' | 'info';
export type Landmark = { id: LandmarkId; label: string; x: number; y: number; w: number; h: number; door: { x: number; y: number } };

export const LANDMARKS: Landmark[] = [
  { id: 'flightDeck', label: 'Flight Deck', x: 2280, y: 420, w: 460, h: 280, door: { x: 2510, y: 760 } },
  { id: 'hall', label: 'Hall of Pioneers', x: 460, y: 420, w: 460, h: 280, door: { x: 690, y: 760 } },
  { id: 'leaderboard', label: 'Top Flock', x: 2300, y: 1520, w: 400, h: 220, door: { x: 2500, y: 1480 } },
  { id: 'info', label: 'Info board', x: 520, y: 1520, w: 360, h: 220, door: { x: 700, y: 1480 } },
];

export function landmarkAt(x: number, y: number): Landmark | undefined {
  return LANDMARKS.find((l) => x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h);
}

export function isWalkable(x: number, y: number): boolean {
  if (x < MARGIN || y < MARGIN || x > WORLD.w - MARGIN || y > WORLD.h - MARGIN) return false;
  return !landmarkAt(x, y);
}

export function randomPlazaPoint(rand = Math.random): { x: number; y: number } {
  const a = rand() * Math.PI * 2;
  const r = PLAZA.r * 0.8 * Math.sqrt(rand());
  return { x: Math.round(PLAZA.x + Math.cos(a) * r), y: Math.round(PLAZA.y + Math.sin(a) * r) };
}

export type Motion = { x0: number; y0: number; tx: number; ty: number; t0: number };

/** Position along a straight walk at constant speed (units/s). */
export function posAt(m: Motion, now: number, speed: number): { x: number; y: number } {
  const dx = m.tx - m.x0, dy = m.ty - m.y0;
  const d = Math.hypot(dx, dy);
  const travelled = (speed * Math.max(0, now - m.t0)) / 1000;
  if (d === 0 || travelled >= d) return { x: m.tx, y: m.ty };
  const f = travelled / d;
  return { x: m.x0 + dx * f, y: m.y0 + dy * f };
}
