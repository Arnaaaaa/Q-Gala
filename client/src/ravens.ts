import type { Bit, RrPhase, RrReaction, RrRole, RrSeat, ServerMsg, Wind } from '../../shared/protocol.ts';
import { TUNABLES } from '../../shared/tunables.ts';
import { cardView, getCard, getIntro } from './cards.ts';
import { h } from './dom.ts';
import type { Net } from './net.ts';
import { store } from './prefs.ts';

const R = TUNABLES.rr;
const INTRO_KEY = 'qg.rrIntroDone';
const ROLE_NAME: Record<RrRole, string> = { sender: 'Sender Robin', receiver: 'Receiver Robin', raven: 'Raven' };
const PHASE_NAME: Record<RrPhase, string> = { launch: 'Launch', choose: 'Choose winds', compare: 'Compare notes', verdict: 'Verdict', result: 'Result' };

type Result = Extract<ServerMsg, { t: 'rrResult' }>;
type Sampled = Extract<ServerMsg, { t: 'rrSampled' }>;
type Compare = Extract<ServerMsg, { t: 'rrCompare' }>;

const flip = (w: Wind): Wind => (w === 'A' ? 'B' : 'A');
const randomWinds = (): Wind[] => Array.from({ length: R.notes }, () => (Math.random() < 0.5 ? 'A' : 'B'));
const GAUGE_MAX = 40;
const scale = (pct: number) => Math.min(100, (pct / GAUGE_MAX) * 100);
const bitChip = (b: Bit) => h('span', { class: `bit bit-${b}` }, String(b));

/**
 * Ravens and Robins. The server runs the match; this view only shows what this
 * player's role is allowed to see and sends their choices.
 */
export class RavensView {
  readonly root = h('div', { class: 'game rr', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Ravens and Robins' });
  private net: Net;
  private onClose: () => void;
  private stage: 'intro' | 'queue' | 'match' | 'end' = 'intro';
  private timer = 0;
  private sendTimer = 0;
  private endsAt = 0;
  private timeEl = h('span', { class: 'gd-time' });
  // Match state
  private seats: RrSeat[] = [];
  private you = 0;
  private rounds: number = R.rounds;
  private round = 0;
  private role: RrRole = 'sender';
  private roles: Record<RrRole, number> = { sender: 0, receiver: 1, raven: 2 };
  private phase: RrPhase = 'launch';
  private secret: { bits: Bit[]; winds: Wind[] } | null = null;
  private myWinds: Wind[] = [];
  private defaults: Wind[] = [];
  private intercepts = new Map<number, Wind>();
  private done = false;
  private reads = new Map<number, Bit>();
  private compare: Compare | null = null;
  private sampled: Sampled | null = null;
  private k: number = R.sample.default;
  private reaction: RrReaction | null = null;
  private reacted = false;
  private result: Result | null = null;

  constructor(net: Net, onClose: () => void) {
    this.net = net;
    this.onClose = onClose;
    this.timer = window.setInterval(() => this.tickClock(), 250);
    if (store.get(INTRO_KEY)) this.join();
    else void this.showIntro(0);
  }

  destroy(): void {
    clearInterval(this.timer);
    clearTimeout(this.sendTimer);
    if (this.stage === 'queue' || this.stage === 'match') this.net.send({ t: 'rrLeave' });
  }

  handle(m: ServerMsg): void {
    switch (m.t) {
      case 'rrQueued':
        this.endsAt = performance.now() + m.botInMs;
        return this.renderQueue();
      case 'rrMatch':
        this.stage = 'match';
        this.seats = m.seats;
        this.you = m.you;
        this.rounds = m.rounds;
        return;
      case 'rrSeats':
        this.seats = m.seats;
        break;
      case 'rrRound':
        Object.assign(this, {
          round: m.round, roles: m.roles, role: m.you, secret: null, myWinds: [], defaults: [], done: false,
          reads: new Map(), compare: null, sampled: null, k: R.sample.default, reaction: null, reacted: false, result: null,
        });
        this.intercepts = new Map();
        break;
      case 'rrPhase':
        this.phase = m.phase;
        this.endsAt = performance.now() + m.msLeft;
        break;
      case 'rrSecret':
        this.secret = { bits: m.bits, winds: m.winds };
        break;
      case 'rrDefaults':
        if (this.role === 'receiver') this.myWinds = [...m.winds];
        else this.defaults = m.winds;
        break;
      case 'rrRead':
        this.reads = new Map(m.reads);
        break;
      case 'rrCompare':
        this.compare = m;
        break;
      case 'rrSampled':
        this.sampled = m;
        break;
      case 'rrReaction':
        this.reaction = m.r;
        break;
      case 'rrResult':
        this.result = m;
        break;
      case 'rrEnd':
        this.stage = 'end';
        void this.showEnd(m);
        return;
      default:
        return;
    }
    if (this.stage === 'match') this.render();
  }

  // ---------- intro and queue ----------

  private async showIntro(i: number): Promise<void> {
    const cards = await getIntro();
    if (!cards.length || i >= cards.length) return this.finishIntro();
    this.root.replaceChildren(
      h('header', { class: 'gd-head' }, h('button', { class: 'btn icon', 'aria-label': 'Close', onclick: this.onClose }, '✕'), h('span', {}, `How to play · ${i + 1} of ${cards.length}`), h('button', { class: 'btn', onclick: () => this.finishIntro() }, 'Skip')),
      h('div', { class: 'gd-end' },
        cardView(cards[i]),
        h('button', { class: 'btn primary', onclick: () => void this.showIntro(i + 1) }, i + 1 < cards.length ? 'Next' : 'Find a match'),
      ),
    );
  }

  private finishIntro(): void {
    store.set(INTRO_KEY, '1');
    this.join();
  }

  private join(): void {
    this.stage = 'queue';
    this.root.replaceChildren(h('div', { class: 'gd-end' }, h('p', {}, 'Joining the queue…')));
    this.net.send({ t: 'rrJoin' });
  }

  private renderQueue(): void {
    this.root.replaceChildren(
      h('div', { class: 'gd-end' },
        h('h2', {}, 'Finding two more birds…'),
        h('p', {}, 'If nobody joins soon, practice bots fill the empty seats in about ', this.timeEl, '.'),
        h('button', { class: 'btn', onclick: this.onClose }, 'Leave the queue'),
      ),
    );
    this.tickClock();
  }

  private tickClock(): void {
    const s = Math.max(0, Math.ceil((this.endsAt - performance.now()) / 1000));
    this.timeEl.textContent = `${s}s`;
    this.timeEl.classList.toggle('low', this.stage === 'match' && s <= 5);
  }

  // ---------- sending choices ----------

  /** Sends the current choice soon (debounced) or now when the player presses Done. */
  private pushChoice(done: boolean): void {
    clearTimeout(this.sendTimer);
    const send = () => {
      if (this.role === 'receiver') this.net.send({ t: 'rrWinds', winds: this.myWinds, done });
      else if (this.role === 'raven') {
        const notes = [...this.intercepts.keys()];
        this.net.send({ t: 'rrIntercept', notes, guesses: notes.map((i) => this.intercepts.get(i)!), done });
      }
    };
    if (done) {
      this.done = true;
      send();
      this.render();
    } else this.sendTimer = window.setTimeout(send, 300);
  }

  // ---------- rendering ----------

  private render(): void {
    this.root.replaceChildren(this.header(), this.scoreStrip(), ...this.body());
    this.tickClock();
  }

  private header(): HTMLElement {
    return h('header', { class: 'gd-head' },
      h('button', { class: 'btn icon', 'aria-label': 'Leave the match', onclick: this.onClose }, '✕'),
      h('span', {}, `Round ${this.round}/${this.rounds}`),
      h('span', { class: `role-chip role-${this.role}`, 'aria-label': `Your role: ${ROLE_NAME[this.role]}` }, ROLE_NAME[this.role].split(' ')[0]),
      this.timeEl,
    );
  }

  private scoreStrip(): HTMLElement {
    const roleOf = (i: number) => (i === this.roles.sender ? 'Sender' : i === this.roles.receiver ? 'Receiver' : 'Raven');
    return h('ul', { class: 'rr-seats' }, ...this.seats.map((s, i) =>
      h('li', { class: i === this.you ? 'me' : '' },
        h('span', { class: 'rr-seat-name' }, s.name, i === this.you ? ' (you)' : ''),
        h('span', { class: 'rr-seat-role' }, roleOf(i)),
        h('strong', {}, String(s.score)),
      ),
    ));
  }

  private body(): (Node | string)[] {
    const title = h('h2', { class: 'rr-phase' }, PHASE_NAME[this.phase]);
    switch (this.phase) {
      case 'launch':
        // The secret arrives just after the phase message.
        return this.role === 'sender' && this.secret
          ? [title, h('p', {}, 'Your 32 notes. Each has a secret bit and a wind (A or B). Only you can see them.'), this.grid((i) => this.secretTile(i))]
          : [title, h('p', {}, 'The Sender Robin is preparing 32 secret notes…')];
      case 'choose':
        return [title, ...this.chooseBody()];
      case 'compare':
        return [title, ...this.compareBody()];
      case 'verdict':
        return [title, ...this.verdictBody()];
      case 'result':
        return [title, ...this.resultBody()];
    }
  }

  private grid(tile: (i: number) => HTMLElement): HTMLElement {
    return h('div', { class: 'rr-grid' }, ...Array.from({ length: R.notes }, (_, i) => tile(i)));
  }

  private tile(i: number, cls: string, ...content: (Node | string)[]): HTMLElement {
    return h('div', { class: `rr-tile ${cls}` }, h('span', { class: 'rr-n' }, String(i + 1)), ...content);
  }

  private secretTile(i: number): HTMLElement {
    const s = this.secret!;
    return this.tile(i, '', bitChip(s.bits[i]), h('span', { class: 'wind' }, s.winds[i]));
  }

  private chooseBody(): (Node | string)[] {
    if (this.role === 'sender') {
      return [h('p', {}, 'The Receiver is picking a wind for each note. A Raven may be peeking…'), this.secret ? this.grid((i) => this.secretTile(i)) : ''];
    }
    if (this.done) return [h('p', {}, 'Locked in. Waiting for the others…')];
    if (this.role === 'receiver') {
      return [
        h('p', {}, 'Pick a wind for each note. Where your wind matches the Sender’s, you’ll read the bit. Tap a note to flip it.'),
        h('div', { class: 'rr-grid' }, ...this.myWinds.map((w, i) =>
          h('button', { class: 'rr-tile tap', 'aria-label': `Note ${i + 1}: wind ${w}`, onclick: () => ((this.myWinds[i] = flip(w)), this.pushChoice(false), this.render()) },
            h('span', { class: 'rr-n' }, String(i + 1)), h('span', { class: 'wind big' }, w)),
        )),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: () => ((this.myWinds = randomWinds()), this.pushChoice(false), this.render()) }, 'Randomize'),
          h('button', { class: 'btn primary', onclick: () => this.pushChoice(true) }, 'Done'),
        ),
      ];
    }
    const n = this.intercepts.size;
    return [
      h('p', {}, `Tap notes to intercept them (up to ${R.maxIntercepts}) and tap again to change your wind guess. Wrong guesses scramble the note, and the Robins may notice.`),
      h('p', { class: 'rr-count', 'aria-live': 'polite' }, `Intercepting ${n} of ${R.maxIntercepts}`),
      h('div', { class: 'rr-grid' }, ...Array.from({ length: R.notes }, (_, i) => {
        const w = this.intercepts.get(i);
        return h('button', {
          class: w ? 'rr-tile tap on' : 'rr-tile tap',
          'aria-label': w ? `Note ${i + 1}: intercepting with wind ${w}` : `Note ${i + 1}: not intercepted`,
          onclick: () => this.cycleIntercept(i),
        }, h('span', { class: 'rr-n' }, String(i + 1)), h('span', { class: 'wind big' }, w ? `👁 ${w}` : '—'));
      })),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => ((this.intercepts = new Map()), this.pushChoice(false), this.render()) }, 'Clear'),
        h('button', { class: 'btn primary', onclick: () => this.pushChoice(true) }, n ? 'Done' : 'Stay hidden'),
      ),
    ];
  }

  /** Not intercepted → default guess → other guess → not intercepted. */
  private cycleIntercept(i: number): void {
    const w = this.intercepts.get(i);
    const first = this.defaults[i] ?? 'A';
    if (!w) {
      if (this.intercepts.size >= R.maxIntercepts) return;
      this.intercepts.set(i, first);
    } else if (w === first) this.intercepts.set(i, flip(first));
    else this.intercepts.delete(i);
    this.pushChoice(false);
    this.render();
  }

  private noteTile(i: number, extra: (Node | string)[] = [], cls = ''): HTMLElement {
    const c = this.compare!;
    const kept = c.kept.includes(i);
    const read = this.reads.get(i);
    return this.tile(i, `${kept ? 'kept' : 'dropped'} ${cls}`,
      h('span', { class: 'winds' }, `${c.senderWinds[i]}·${c.receiverWinds[i]}`),
      kept ? h('span', { class: 'mark' }, '✓ kept') : h('span', { class: 'mark dim' }, 'no match'),
      this.role === 'sender' && this.secret ? bitChip(this.secret.bits[i]) : '',
      read !== undefined ? h('span', { class: 'read' }, '👁 ', bitChip(read)) : '',
      ...extra,
    );
  }

  private compareBody(): (Node | string)[] {
    const c = this.compare;
    if (!c) return [];
    const intro = h('p', {}, `Both Robins’ winds are now public (Sender·Receiver). ${c.kept.length} notes matched and are kept; the rest are dropped.`);
    const grid = this.grid((i) => this.noteTile(i));
    if (this.role !== 'sender') return [intro, h('p', {}, 'The Sender is choosing how many kept notes to sacrifice for checking…'), grid];
    const set = (k: number) => ((this.k = Math.max(R.sample.min, Math.min(R.sample.max, k))), this.render());
    return [
      intro,
      h('p', {}, 'Sacrifice some kept notes to check for errors. More checks catch a Raven more often but leave a shorter key.'),
      h('div', { class: 'stepper' },
        h('button', { class: 'btn icon', 'aria-label': 'Check fewer notes', onclick: () => set(this.k - 1) }, '−'),
        h('span', { 'aria-live': 'polite' }, `${this.k} notes`),
        h('button', { class: 'btn icon', 'aria-label': 'Check more notes', onclick: () => set(this.k + 1) }, '+'),
      ),
      h('button', { class: 'btn primary', onclick: () => this.net.send({ t: 'rrSample', k: this.k }) }, `Check ${this.k} notes`),
      grid,
    ];
  }

  private sampleSummary(): HTMLElement[] {
    const s = this.sampled;
    if (!s) return [];
    const [lo, hi] = s.forecast;
    const pct = s.notes.length ? Math.round((100 * s.disagree) / s.notes.length) : 0;
    return [
      h('p', { class: 'rr-big' }, `${s.disagree} of ${s.notes.length} checked notes disagreed (${pct}%)`),
      // The bar spans 0–GAUGE_MAX % errors; the gold band is the forecast, the white line the checked result.
      h('div', { class: 'gauge', role: 'img', 'aria-label': `Storm forecast ${lo} to ${hi} percent; checked notes disagreed ${pct} percent` },
        h('div', { class: 'gauge-band', style: `left:${scale(lo)}%;width:${scale(hi) - scale(lo)}%` }),
        h('div', { class: 'gauge-mark', style: `left:${scale(pct)}%` }),
      ),
      h('p', { class: 'gauge-legend' }, h('span', { class: 'swatch' }), ` Storm forecast: ${lo}–${hi}% errors · ▌ checked: ${pct}%`),
    ];
  }

  private sampledTile(i: number): HTMLElement {
    const s = this.sampled!;
    const j = s.notes.indexOf(i);
    if (j < 0) return this.noteTile(i);
    const agree = s.senderBits[j] === s.receiverBits[j];
    return this.noteTile(i, [h('span', { class: agree ? 'check ok' : 'check bad' }, agree ? '✓ same' : '✗ differ', ' ', bitChip(s.senderBits[j]), '/', bitChip(s.receiverBits[j]))], 'sampled');
  }

  private verdictBody(): (Node | string)[] {
    const parts: (Node | string)[] = [...this.sampleSummary()];
    if (this.role === 'sender') {
      parts.push(this.reacted
        ? h('p', {}, 'Reaction sent. The Receiver decides.')
        : h('div', { class: 'row' },
            h('button', { class: 'btn', onclick: () => this.react('fine') }, 'Looks fine'),
            h('button', { class: 'btn', onclick: () => this.react('raven') }, 'I smell a Raven'),
          ));
    } else if (this.role === 'receiver') {
      parts.push(
        h('p', { 'aria-live': 'polite' }, this.reaction ? `Sender says: “${this.reaction === 'fine' ? 'Looks fine' : 'I smell a Raven'}”` : 'The Sender may send a reaction…'),
        h('p', { class: 'small' }, 'Weather or Raven? Trust keeps the key. Abort catches a spy, but if there was none, the Raven wins a bluff. No answer counts as Abort.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', onclick: () => this.net.send({ t: 'rrVerdict', v: 'trust' }) }, 'Trust'),
          h('button', { class: 'btn', onclick: () => this.net.send({ t: 'rrVerdict', v: 'abort' }) }, 'Abort'),
        ),
      );
    } else parts.push(h('p', {}, 'The Robins are deciding whether to trust the key…'));
    parts.push(this.grid((i) => this.sampledTile(i)));
    return parts;
  }

  private react(r: RrReaction): void {
    this.reacted = true;
    this.net.send({ t: 'rrReact', r });
    this.render();
  }

  private resultBody(): (Node | string)[] {
    const r = this.result;
    if (!r) return [];
    const headline =
      r.outcome === 'foiled' ? 'Spy foiled! The Robins aborted and caught the Raven.'
      : r.outcome === 'falseAlarm' ? 'False alarm! There was no Raven, so the Raven wins a bluff.'
      : `Trusted. The secret key has ${r.key.length} notes; the Raven learned ${r.learned.length} of them.`;
    const intercepted = new Set(r.intercepted), learned = new Set(r.learned), key = new Set(r.key);
    return [
      h('p', { class: 'rr-big' }, headline),
      h('ul', { class: 'rr-points' }, ...this.seats.map((s, i) => h('li', {}, `${s.name}: +${r.points[i]}`))),
      h('p', { class: 'small' }, `The Raven intercepted ${r.intercepted.length} note${r.intercepted.length === 1 ? '' : 's'}. 🔑 = key note, 👁 = intercepted, ⚠ = key note the Raven learned.`),
      this.grid((i) => this.tile(i, key.has(i) ? 'kept' : 'dropped',
        key.has(i) ? h('span', {}, '🔑') : '',
        intercepted.has(i) ? h('span', {}, '👁') : '',
        learned.has(i) ? h('span', { class: 'check bad' }, '⚠') : '',
      )),
      h('p', { class: 'small' }, this.round < this.rounds ? 'Next round starts soon. Roles rotate.' : 'Final scores coming up…'),
    ];
  }

  private async showEnd(m: Extract<ServerMsg, { t: 'rrEnd' }>): Promise<void> {
    clearInterval(this.timer);
    const card = await getCard('ravens');
    const ranked = m.seats.map((s, i) => ({ ...s, i })).sort((a, b) => b.score - a.score);
    this.root.replaceChildren(
      h('div', { class: 'gd-end' },
        h('h2', {}, 'Match over'),
        h('p', { class: 'gd-score' }, `Your score: ${m.seats[m.you].score}`),
        h('p', {}, m.newBest ? 'New personal best!' : `Personal best: ${m.best}`),
        h('ol', { class: 'rr-points' }, ...ranked.map((s) => h('li', { class: s.i === m.you ? 'me' : '' }, `${s.name}: ${s.score}`))),
        card && cardView(card),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', onclick: () => ((this.timer = window.setInterval(() => this.tickClock(), 250)), this.join()) }, 'Play again'),
          h('button', { class: 'btn', onclick: this.onClose }, 'Back to the hub'),
        ),
      ),
    );
  }
}
