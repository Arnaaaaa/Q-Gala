import { GOLD, INDIGO, VIOLET } from '../../shared/colors.ts';

// The Q-Gala perching bird, facing right, in a 100×100 box: traced from the organisers' outline
// drawing (tail notch, raised head, two gold legs). Used by both SVG and canvas.
const BODY = 'M1.1 73.1 C1.1 73.1 11.4 67.7 15.8 64.7 C20.2 61.7 24.3 58.1 27.3 55.3 C30.3 52.5 31.3 50.4 33.6 47.9 C35.9 45.4 38.3 42.8 40.9 40.5 C43.5 38.2 46.8 36.3 49.4 34.3 C52 32.3 55 30.4 56.7 28.5 C58.4 26.6 58.4 24.8 59.8 22.7 C61.2 20.6 63.3 17.6 65.1 15.9 C66.8 14.2 68.5 13 70.3 12.2 C72 11.4 73.8 10.8 75.6 10.9 C77.3 11 79.1 11.5 80.8 12.7 C82.5 13.8 85.6 17.8 85.6 17.8 L84 23.2 C84 23.2 81.5 26 80.8 27.9 C80.1 29.8 80.1 32 80 34.3 C79.9 36.6 80.4 39 80.3 41.6 C80.2 44.2 80.3 47 79.3 50 C78.3 53 76.7 56.8 74.5 59.4 C72.3 62 69.4 64.1 66.1 65.8 C62.8 67.5 59.5 69.2 54.6 69.4 C49.7 69.6 41.7 66.9 36.8 66.8 C31.9 66.7 25.2 68.9 25.2 68.9 L4.2 81 L2.6 79.9 L5.3 75.2 L1.1 73.1Z';
const WING = 'M62 38 Q67 52 56 59 Q40 66 24 63 Q38 52 48 44 Q55 38 62 38Z';
const BEAK = 'M84.6 17.4 L92.6 21.1 L83.8 23.6Z';
const LEGS = 'M46.2 69.9 L49.4 79.4 L53 85.2 M49.4 85.7 L57.2 85.5 M54.6 69.9 L55.6 79.4 L59.8 85.7 M57.2 86.2 L65.6 86.2';
const OUTLINE = '#120726';
const GRAD_TOP = 11, GRAD_BOTTOM = 81;
const EYE = { x: 78.6, y: 17, r: 2.6 };
const MARK_X = 71, MARK0_Y = 43, MARK1_Y = 58;

/** P0 sets where indigo (|0⟩, top) gives way to violet (|1⟩, bottom). */
function stops(p0: number): [number, string][] {
  if (p0 >= 100) return [[0, INDIGO], [1, INDIGO]];
  if (p0 <= 0) return [[0, VIOLET], [1, VIOLET]];
  return [[0, INDIGO], [Math.max(0, p0 - 3) / 100, INDIGO], [Math.min(100, p0 + 3) / 100, VIOLET], [1, VIOLET]];
}

/** `solid` shows a measurement result instead of the odds. */
export type Look = { p0: number; solid?: 0 | 1 | null };

const effectiveP0 = (l: Look) => (l.solid === 0 ? 100 : l.solid === 1 ? 0 : l.p0);

const NS = 'http://www.w3.org/2000/svg';
let gradSeq = 0;

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

export function createBirdSvg(label: string): { el: SVGSVGElement; set: (l: Look) => void } {
  const id = `qg-grad-${gradSeq++}`;
  const svg = svgEl('svg', { viewBox: '0 0 100 100', class: 'bird', role: 'img', 'aria-label': label });
  const grad = svgEl('linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: 0, y1: GRAD_TOP, x2: 0, y2: GRAD_BOTTOM });
  const defs = svgEl('defs', {});
  defs.append(grad);
  const mark = (text: string, y: number) => {
    const t = svgEl('text', { x: MARK_X, y, class: 'chest-mark', 'text-anchor': 'middle' });
    t.textContent = text;
    return t;
  };
  const m0 = mark('0', MARK0_Y), m1 = mark('1', MARK1_Y);
  svg.append(
    defs,
    svgEl('path', { d: LEGS, stroke: GOLD, 'stroke-width': 3, 'stroke-linecap': 'round', fill: 'none' }),
    svgEl('path', { d: BODY, fill: `url(#${id})`, stroke: OUTLINE, 'stroke-width': 2.5, 'stroke-linejoin': 'round' }),
    svgEl('path', { d: WING, fill: 'rgba(255,255,255,0.18)', stroke: OUTLINE, 'stroke-width': 1.5 }),
    svgEl('path', { d: BEAK, fill: GOLD, stroke: OUTLINE, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }),
    svgEl('circle', { cx: EYE.x, cy: EYE.y, r: EYE.r, fill: OUTLINE }),
    m0,
    m1,
  );
  const set = (l: Look) => {
    const p = effectiveP0(l);
    grad.replaceChildren(...stops(p).map(([o, c]) => svgEl('stop', { offset: o, 'stop-color': c })));
    m0.setAttribute('opacity', String(p / 100));
    m1.setAttribute('opacity', String((100 - p) / 100));
  };
  return { el: svg, set };
}

const paths = { body: new Path2D(BODY), wing: new Path2D(WING), beak: new Path2D(BEAK), legs: new Path2D(LEGS) };

/** Draws a bird centred on (x, y) with height `size` in the current canvas transform. */
export function drawBird(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, l: Look & { alpha?: number; flip?: boolean }): void {
  const p = effectiveP0(l);
  ctx.save();
  ctx.globalAlpha = l.alpha ?? 1;
  ctx.translate(x, y);
  ctx.scale((l.flip ? -size : size) / 100, size / 100);
  ctx.translate(-46, -50);
  const g = ctx.createLinearGradient(0, GRAD_TOP, 0, GRAD_BOTTOM);
  for (const [o, c] of stops(p)) g.addColorStop(o, c);
  ctx.lineJoin = 'round';
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 3;
  ctx.stroke(paths.legs);
  ctx.fillStyle = g;
  ctx.fill(paths.body);
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 2.5;
  ctx.stroke(paths.body);
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fill(paths.wing);
  ctx.fillStyle = GOLD;
  ctx.fill(paths.beak);
  ctx.fillStyle = OUTLINE;
  ctx.beginPath();
  ctx.arc(EYE.x, EYE.y, EYE.r, 0, Math.PI * 2);
  ctx.fill();
  // Chest marks: the non-colour cue for the odds.
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3;
  for (const [txt, ty, a] of [['0', MARK0_Y, p / 100], ['1', MARK1_Y, (100 - p) / 100]] as const) {
    if (a <= 0) continue;
    ctx.globalAlpha = (l.alpha ?? 1) * a;
    ctx.strokeStyle = OUTLINE;
    ctx.strokeText(txt, MARK_X, ty);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(txt, MARK_X, ty);
  }
  ctx.restore();
}

export function createEggSvg(): SVGSVGElement {
  const svg = svgEl('svg', { viewBox: '0 0 100 120', class: 'egg', role: 'img', 'aria-label': 'An unhatched egg shimmering between indigo and violet' });
  const shape = 'M50 6 C78 6 92 56 92 78 C92 102 72 116 50 116 C28 116 8 102 8 78 C8 56 22 6 50 6Z';
  svg.append(
    svgEl('path', { d: shape, fill: INDIGO, stroke: OUTLINE, 'stroke-width': 2.5 }),
    svgEl('path', { d: shape, fill: VIOLET, class: 'egg-flicker' }),
    svgEl('path', { d: shape, fill: 'none', stroke: OUTLINE, 'stroke-width': 2.5 }),
    svgEl('path', { d: 'M30 40 Q36 26 46 22', stroke: 'rgba(255,255,255,0.5)', 'stroke-width': 4, fill: 'none', 'stroke-linecap': 'round' }),
  );
  return svg;
}
