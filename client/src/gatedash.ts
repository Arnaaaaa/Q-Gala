import { applyGate, GATES, stateLabel, type Gate, type QState } from '../../shared/gates.ts';
import type { ServerMsg } from '../../shared/protocol.ts';
import { TUNABLES } from '../../shared/tunables.ts';
import { createBirdSvg } from './bird.ts';
import { cardView, getCard } from './cards.ts';
import { h } from './dom.ts';
import type { Net } from './net.ts';
import { store } from './prefs.ts';

const PRACTICE_KEY = 'qg.gdPracticeDone';
const PRACTICE: { start: QState; target: QState; hint: string }[] = [
  { start: '0', target: '1', hint: 'X swaps 0 and 1. Tap X.' },
  { start: '0', target: '+', hint: 'H turns a definite 0 into an equal superposition, |+⟩. Tap H.' },
  { start: '+', target: '-', hint: 'Z flips the phase, so |+⟩ becomes |−⟩. Tap Z.' },
];

const P0_OF: Record<QState, number> = { '0': 100, '1': 0, '+': 50, '-': 50 };

/** A qubit state as a bird plus its label. |+⟩ and |−⟩ also get a sign and a shimmer arrow, never colour alone. */
export function stateIcon(s: QState, caption: string): HTMLElement {
  const bird = createBirdSvg(`${caption}: ${stateLabel(s)}`);
  bird.set({ p0: P0_OF[s] });
  const pm = s === '+' || s === '-';
  return h('figure', { class: 'qstate' },
    h('div', { class: 'qstate-art' }, bird.el,
      pm && h('span', { class: 'qstate-sign', 'aria-hidden': 'true' }, s === '+' ? '+' : '−'),
      pm && h('span', { class: `qstate-arrow ${s === '+' ? 'right' : 'left'}`, 'aria-hidden': 'true' }, s === '+' ? '→' : '←'),
    ),
    h('figcaption', {}, h('span', { class: 'qstate-cap' }, caption), h('strong', {}, stateLabel(s))),
  );
}

type Level = { level: number; start: QState; target: QState; min: number; gates: readonly Gate[]; hint?: string };

/**
 * Gate Dash. The server sends one level at a time and checks each solution;
 * the client only predicts states so taps feel instant.
 */
export class GateDashView {
  readonly root = h('div', { class: 'game', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Gate Dash' });
  private net: Net;
  private onClose: () => void;
  private mode: 'practice' | 'run' | 'idle' = 'idle';
  private lv: Level | null = null;
  private state: QState = '0';
  private gates: Gate[] = [];
  private dts: number[] = [];
  private lastTap = 0;
  private locked = false;
  private practiceIdx = 0;
  private score = 0;
  private endsAt = 0;
  private clock = 0;
  private timeEl = h('span', { class: 'gd-time' });
  private live = h('p', { class: 'gd-live', 'aria-live': 'polite' });

  constructor(net: Net, onClose: () => void) {
    this.net = net;
    this.onClose = onClose;
    if (store.get(PRACTICE_KEY)) this.startRun();
    else this.startPractice();
  }

  destroy(): void {
    clearInterval(this.clock);
    if (this.mode === 'run') this.net.send({ t: 'gdQuit' });
    this.mode = 'idle';
  }

  handle(m: ServerMsg): void {
    if (this.mode !== 'run') return;
    if (m.t === 'gdLevel') {
      this.score = m.score;
      this.endsAt = performance.now() + m.msLeft;
      if (m.gained) this.live.textContent = `+${m.gained}${m.gained > TUNABLES.gateDash.pointsPerLevel ? ' (fewest gates!)' : ''}`;
      else if (this.lv?.level === m.level) this.live.textContent = 'Try that level again.';
      this.setLevel({ level: m.level, start: m.start, target: m.target, min: m.min, gates: m.gates });
    } else if (m.t === 'gdEnd') {
      this.mode = 'idle';
      clearInterval(this.clock);
      void this.showEnd(m.score, m.best, m.newBest);
    }
  }

  private startPractice(): void {
    this.mode = 'practice';
    this.practiceIdx = 0;
    this.setLevel({ level: 1, min: 1, gates: GATES, ...PRACTICE[0] });
  }

  private finishPractice(): void {
    store.set(PRACTICE_KEY, '1');
    this.mode = 'idle';
    this.root.replaceChildren(
      h('div', { class: 'gd-end' },
        h('h2', {}, 'Practice done!'),
        h('p', {}, 'Now the real run: solve as many levels as you can in 60 seconds. Fewest gates earns a bonus.'),
        h('button', { class: 'btn primary', onclick: () => this.startRun() }, 'Start the run'),
        h('button', { class: 'btn', onclick: this.onClose }, 'Back to the hub'),
      ),
    );
  }

  private startRun(): void {
    this.mode = 'run';
    this.lv = null;
    this.score = 0;
    this.endsAt = performance.now() + TUNABLES.gateDash.runMs;
    this.root.replaceChildren(h('div', { class: 'gd-end' }, h('p', {}, 'Get ready…')));
    clearInterval(this.clock);
    this.clock = window.setInterval(() => this.tickClock(), 250);
    this.net.send({ t: 'gdStart' });
  }

  private tickClock(): void {
    const s = Math.max(0, Math.ceil((this.endsAt - performance.now()) / 1000));
    this.timeEl.textContent = `${s}s`;
    this.timeEl.classList.toggle('low', s <= 10);
  }

  private setLevel(lv: Level): void {
    this.lv = lv;
    this.state = lv.start;
    this.gates = [];
    this.dts = [];
    this.lastTap = performance.now();
    this.locked = false;
    this.render();
  }

  private tap(g: Gate): void {
    const now = performance.now();
    // Ignore accidental double taps the server would reject as impossibly fast.
    if (this.locked || !this.lv || !this.lv.gates.includes(g) || now - this.lastTap < TUNABLES.gateDash.minTapGapMs) return;
    this.dts.push(Math.round(now - this.lastTap));
    this.lastTap = now;
    this.gates.push(g);
    this.state = applyGate(this.state, g);
    if (this.state === this.lv.target) this.solved();
    this.render();
  }

  private reset(): void {
    if (!this.lv || this.locked) return;
    this.setLevel(this.lv);
  }

  private solved(): void {
    this.locked = true;
    if (this.mode === 'run') {
      this.net.send({ t: 'gdSolve', level: this.lv!.level, gates: this.gates, dts: this.dts });
      return;
    }
    this.live.textContent = 'Nice!';
    window.setTimeout(() => {
      if (this.mode !== 'practice') return;
      if (++this.practiceIdx >= PRACTICE.length) this.finishPractice();
      else this.setLevel({ level: this.practiceIdx + 1, min: 1, gates: GATES, ...PRACTICE[this.practiceIdx] });
    }, 700);
  }

  private render(): void {
    const lv = this.lv!;
    const practice = this.mode === 'practice';
    const quit = h('button', { class: 'btn icon', 'aria-label': 'Quit Gate Dash', onclick: this.onClose }, '✕');
    if (!practice) this.tickClock();
    this.root.replaceChildren(
      h('header', { class: 'gd-head' },
        quit,
        h('span', {}, practice ? `Practice ${this.practiceIdx + 1} of ${PRACTICE.length}` : `Level ${lv.level}`),
        practice ? h('button', { class: 'btn', onclick: () => this.finishPractice() }, 'Skip') : h('span', {}, `Score ${this.score}`),
        practice ? '' : this.timeEl,
      ),
      h('div', { class: 'gd-board' },
        stateIcon(this.state, 'Now'),
        h('span', { class: 'gd-to', 'aria-hidden': 'true' }, '⇒'),
        stateIcon(lv.target, 'Goal'),
      ),
      h('p', { class: 'gd-info' }, `Started at ${stateLabel(lv.start)} · fewest gates: ${lv.min}`),
      h('p', { class: 'gd-trail' }, this.gates.length ? `Gates: ${this.gates.join(' ')}` : 'Tap a gate'),
      lv.hint ? h('p', { class: 'gd-hint' }, lv.hint) : '',
      lv.gates.length < GATES.length ? h('p', { class: 'gd-hint' }, `Only ${lv.gates.join(' and ')} work on this level.`) : '',
      this.live,
      h('div', { class: 'gd-pad' },
        ...GATES.map((g) => {
          const open = lv.gates.includes(g);
          return h('button', { class: open ? 'btn gate' : 'btn gate locked', onclick: () => this.tap(g), disabled: this.locked || !open, 'aria-label': open ? `Gate ${g}` : `Gate ${g} (locked)` }, open ? g : `${g} 🔒`);
        }),
      ),
      h('button', { class: 'btn', onclick: () => this.reset(), disabled: this.locked || !this.gates.length }, 'Reset level'),
    );
  }

  private async showEnd(score: number, best: number, newBest: boolean): Promise<void> {
    const card = await getCard('gateDash');
    this.root.replaceChildren(
      h('div', { class: 'gd-end' },
        h('h2', {}, "Time's up!"),
        h('p', { class: 'gd-score' }, `Score: ${score}`),
        h('p', {}, newBest ? 'New personal best!' : `Personal best: ${best}`),
        card && cardView(card),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', onclick: () => this.startRun() }, 'Play again'),
          h('button', { class: 'btn', onclick: this.onClose }, 'Back to the hub'),
        ),
      ),
    );
  }
}
