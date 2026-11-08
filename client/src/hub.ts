import { GOLD } from '../../shared/colors.ts';
import { isWalkable, landmarkAt, LANDMARKS, PLAZA, posAt, WORLD, type Landmark, type Motion } from '../../shared/map.ts';
import { PHRASE_GROUPS, PHRASES, type Emote } from '../../shared/phrases.ts';
import type { BirdDTO, ClientMsg, LeaderRow, ServerMsg } from '../../shared/protocol.ts';
import { TUNABLES } from '../../shared/tunables.ts';
import { createBirdSvg, drawBird } from './bird.ts';
import { h } from './dom.ts';
import { INFO_BOARD, LANDMARK_SOON } from './content.ts';
import { GateDashView } from './gatedash.ts';
import { HallView } from './hall.ts';
import { RavensView } from './ravens.ts';
import type { Net } from './net.ts';
import { reduceMotion, setReduceMotion } from './prefs.ts';

type ViewBird = Motion & {
  id: string;
  name: string;
  p0: number;
  idle: boolean;
  flip: boolean;
  bubble?: { text: string; until: number };
  emote?: { e: Emote; o?: 0 | 1; start: number };
};

const H = TUNABLES.hub;
const BIRD_SIZE = 64;

const EMOTE_LABELS: Record<Emote, string> = { wave: '👋 Wave', clap: '👏 Clap', heart: '❤️ Heart', flap: '🪶 Flap', collapse: 'Collapse', superpose: 'Superpose' };
const EMOTE_ICONS: Partial<Record<Emote, string>> = { wave: '👋', clap: '👏', heart: '❤️', flap: '🪶' };

// Deterministic star field so every player sees the same sky.
const STARS = Array.from({ length: 140 }, (_, i) => {
  const r = (n: number) => ((Math.sin(i * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1;
  return { x: r(1) * WORLD.w, y: r(2) * WORLD.h, s: 1 + r(3) * 2 };
});

export class HubView {
  readonly root: HTMLElement;
  private canvas = h('canvas', { class: 'hub-canvas', 'aria-label': 'The Aviary. Tap to walk.' });
  private ctx = this.canvas.getContext('2d')!;
  private onlineEl = h('div', { class: 'hud-online', 'aria-live': 'polite' }, '1 bird online');
  private panel = h('div', { class: 'panel-host' });
  private gameHost = h('div', { class: 'game-host' });
  private game: GateDashView | RavensView | HallView | null = null;
  private panelTimer = 0;
  private birds = new Map<string, ViewBird>();
  private youId = '';
  private cam = { x: PLAZA.x, y: PLAZA.y };
  private scale = 1;
  private dpr = 1;
  private raf = 0;
  private marker: { x: number; y: number; t: number } | null = null;
  private down: { x: number; y: number } | null = null;
  private net: Net;
  private opts: { isAdmin: () => boolean; inviteUrl: () => string | null; onMyBird: () => void; onSignOut: () => void };
  private banner = h('div', { class: 'announce', role: 'status', hidden: true });
  private admin: AdminDrawer | null = null;

  constructor(net: Net, opts: HubView['opts']) {
    this.net = net;
    this.opts = opts;
    const menuBtn = h('button', { class: 'btn icon', 'aria-label': 'Menu', onclick: () => this.openMenu() }, '☰');
    const chatBtn = h('button', { class: 'btn chat-btn', onclick: () => this.openChat() }, '💬 Chat');
    this.root = h('div', { class: 'hub' },
      this.canvas,
      h('div', { class: 'hud' }, this.onlineEl, h('div', { class: 'hud-right' },
        this.opts.isAdmin() ? h('button', { class: 'btn admin-btn', 'aria-label': 'Admin tools', onclick: () => this.toggleAdmin() }, '🛡 Admin') : '',
        menuBtn,
      )),
      this.banner,
      h('div', { class: 'hud hud-bottom' }, chatBtn),
      this.panel,
      this.gameHost,
    );
    this.canvas.addEventListener('pointerdown', (e) => (this.down = { x: e.clientX, y: e.clientY }));
    this.canvas.addEventListener('pointerup', (e) => {
      if (this.down && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) < 12) this.tap(e.clientX, e.clientY);
      this.down = null;
    });
    window.addEventListener('resize', this.resize);
  }

  start(): void {
    this.resize();
    const loop = () => {
      this.draw(performance.now());
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  destroy(): void {
    this.admin?.destroy();
    this.closeGame();
    this.closePanel();
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
  }

  get me(): ViewBird | undefined {
    return this.birds.get(this.youId);
  }

  handle(m: ServerMsg): void {
    const now = performance.now();
    switch (m.t) {
      case 'hubState':
        this.birds.clear();
        this.youId = m.you.id;
        this.addBird(m.you, now);
        this.cam = { x: m.you.x, y: m.you.y };
        this.setOnline(m.online);
        break;
      case 'enter':
        this.addBird(m.bird, now);
        break;
      case 'leave':
        this.birds.delete(m.id);
        break;
      case 'moved': {
        const b = this.birds.get(m.id);
        // Our own walk is predicted locally; only accept the echo if it disagrees.
        if (b && !(m.id === this.youId && b.tx === m.tx && b.ty === m.ty)) this.setMotion(b, m.x, m.y, m.tx, m.ty, now);
        break;
      }
      case 'sync':
        for (const [id, x, y, tx, ty] of m.b) {
          const b = this.birds.get(id);
          if (!b) continue;
          const p = posAt(b, now, H.walkSpeed);
          if (Math.hypot(p.x - x, p.y - y) > 40 || b.tx !== tx || b.ty !== ty) this.setMotion(b, x, y, tx, ty, now);
        }
        break;
      case 'idle': {
        const b = this.birds.get(m.id);
        if (b) b.idle = m.idle;
        break;
      }
      case 'birdChanged': {
        const b = this.birds.get(m.id);
        if (b) b.p0 = m.p0;
        break;
      }
      case 'online':
        this.setOnline(m.n);
        break;
      case 'said': {
        const b = this.birds.get(m.id);
        if (b) b.bubble = { text: PHRASES[m.p] ?? '', until: now + TUNABLES.chat.bubbleMs };
        break;
      }
      case 'emoted': {
        const b = this.birds.get(m.id);
        if (b) b.emote = { e: m.e, o: m.o, start: now };
        break;
      }
      case 'leaderboard':
        this.renderLeaderboard(m.top, m.me);
        break;
      case 'announcement':
        this.showAnnouncement(m.text);
        break;
      case 'adminList':
      case 'adminDone':
        this.admin?.handle(m);
        break;
      default:
        // Game messages go to whichever game screen is open.
        if (m.t.startsWith('gd') || m.t.startsWith('rr')) {
          if (this.game && !(this.game instanceof HallView)) this.game.handle(m);
        }
        break;
    }
  }

  private showAnnouncement(text: string | null): void {
    this.banner.hidden = !text;
    this.banner.replaceChildren(
      h('span', { class: 'announce-icon', 'aria-hidden': 'true' }, '📣'),
      h('span', {}, text ?? ''),
      h('button', { class: 'btn icon small', 'aria-label': 'Hide announcement', onclick: () => (this.banner.hidden = true) }, '✕'),
    );
  }

  private toggleAdmin(): void {
    if (this.admin) {
      this.admin.destroy();
      this.admin = null;
    } else {
      this.admin = new AdminDrawer(this.net, () => this.toggleAdmin());
      this.root.append(this.admin.root);
    }
  }

  private setOnline(n: number): void {
    this.onlineEl.textContent = `${n} ${n === 1 ? 'bird' : 'birds'} online`;
  }

  private addBird(d: BirdDTO, now: number): void {
    this.birds.set(d.id, { id: d.id, name: d.name, p0: d.p0, idle: d.idle, x0: d.x, y0: d.y, tx: d.tx, ty: d.ty, t0: now, flip: d.tx < d.x });
  }

  private setMotion(b: ViewBird, x: number, y: number, tx: number, ty: number, now: number): void {
    Object.assign(b, { x0: x, y0: y, tx, ty, t0: now });
    if (tx !== x) b.flip = tx < x;
  }

  private walkTo(x: number, y: number): void {
    const me = this.me;
    if (!me || !isWalkable(x, y)) return;
    const now = performance.now();
    const p = posAt(me, now, H.walkSpeed);
    this.setMotion(me, p.x, p.y, Math.round(x), Math.round(y), now);
    me.idle = false;
    this.marker = { x, y, t: now };
    this.net.send({ t: 'move', x: Math.round(x), y: Math.round(y) });
  }

  private tap(sx: number, sy: number): void {
    if (this.panel.childElementCount || this.game) return;
    const rect = this.canvas.getBoundingClientRect();
    const wx = this.cam.x + (sx - rect.left - rect.width / 2) / this.scale;
    const wy = this.cam.y + (sy - rect.top - rect.height / 2) / this.scale;
    const lm = landmarkAt(wx, wy);
    if (lm) {
      this.walkTo(lm.door.x, lm.door.y);
      this.openLandmark(lm);
    } else this.walkTo(wx, wy);
  }

  private resize = (): void => {
    const w = this.canvas.clientWidth || window.innerWidth;
    const hgt = this.canvas.clientHeight || window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(hgt * this.dpr);
    this.scale = Math.max(w, hgt) / H.viewSpan;
  };

  private draw(now: number): void {
    const { ctx, canvas } = this;
    const w = canvas.width / this.dpr, hgt = canvas.height / this.dpr;
    const me = this.me;
    if (me) {
      const p = posAt(me, now, H.walkSpeed);
      const k = reduceMotion() ? 1 : 0.12;
      this.cam.x += (p.x - this.cam.x) * k;
      this.cam.y += (p.y - this.cam.y) * k;
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const sky = ctx.createLinearGradient(0, 0, 0, hgt);
    sky.addColorStop(0, '#12062b');
    sky.addColorStop(1, '#2b1458');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, hgt);

    // World space.
    ctx.translate(w / 2, hgt / 2);
    ctx.scale(this.scale, this.scale);
    ctx.translate(-this.cam.x, -this.cam.y);

    ctx.fillStyle = '#2a1652';
    roundRect(ctx, 0, 0, WORLD.w, WORLD.h, 80);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    for (const s of STARS) ctx.fillRect(s.x, s.y, s.s, s.s);

    ctx.strokeStyle = '#3f2a7a';
    ctx.lineWidth = 70;
    ctx.lineCap = 'round';
    for (const l of LANDMARKS) {
      ctx.beginPath();
      ctx.moveTo(PLAZA.x, PLAZA.y);
      ctx.lineTo(l.door.x, l.door.y);
      ctx.stroke();
    }
    ctx.fillStyle = '#3f2a7a';
    ctx.beginPath();
    ctx.arc(PLAZA.x, PLAZA.y, PLAZA.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(241,194,27,0.35)';
    ctx.lineWidth = 6;
    ctx.stroke();

    for (const l of LANDMARKS) this.drawLandmark(l);

    if (this.marker && now - this.marker.t < 1200) {
      const a = 1 - (now - this.marker.t) / 1200;
      ctx.strokeStyle = `rgba(241,194,27,${a})`;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.ellipse(this.marker.x, this.marker.y + 28, 26, 10, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    const drawn = [...this.birds.values()]
      .map((b) => ({ b, p: posAt(b, now, H.walkSpeed) }))
      .sort((a, c) => a.p.y - c.p.y);
    for (const { b, p } of drawn) {
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y + 30, 22, 7, 0, 0, Math.PI * 2);
      ctx.fill();
      const fx = this.emoteLook(b, now);
      drawBird(ctx, p.x, p.y - fx.lift, BIRD_SIZE, { p0: b.p0, solid: fx.solid, alpha: b.idle ? 0.4 : 1, flip: b.flip });
    }

    // Labels, emote icons and bubbles in screen space so they stay crisp and readable.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    for (const { b, p } of drawn) {
      const sx = (p.x - this.cam.x) * this.scale + w / 2;
      const sy = (p.y - this.cam.y - BIRD_SIZE * 0.6) * this.scale + hgt / 2;
      if (sx < -100 || sx > w + 100 || sy < -40 || sy > hgt + 40) continue;
      ctx.globalAlpha = b.idle ? 0.5 : 1;
      ctx.font = '600 14px system-ui, sans-serif';
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#120726';
      ctx.strokeText(b.name, sx, sy);
      ctx.fillStyle = b.id === this.youId ? GOLD : '#ffffff';
      ctx.fillText(b.name, sx, sy);
      const icon = this.emoteIcon(b, now);
      if (icon) {
        ctx.font = '700 24px system-ui, sans-serif';
        ctx.strokeText(icon, sx + 40, sy + 4);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(icon, sx + 40, sy + 4);
      }
      if (b.bubble && b.bubble.until > now) drawBubble(ctx, b.bubble.text, sx, sy - 20);
    }
    ctx.globalAlpha = 1;
  }

  /** Emote effects on the bird itself. Nothing alternates faster than 2.5 times a second. */
  private emoteLook(b: ViewBird, now: number): { solid: 0 | 1 | null; lift: number } {
    const e = b.emote;
    const t = e ? now - e.start : Infinity;
    if (!e || t > TUNABLES.chat.emoteMs) return { solid: null, lift: 0 };
    const calm = reduceMotion();
    switch (e.e) {
      case 'collapse':
        return { solid: e.o ?? null, lift: 0 };
      case 'superpose':
        return { solid: calm ? null : Math.floor(t / 400) % 2 === 0 ? 0 : 1, lift: 0 };
      case 'flap':
        return { solid: null, lift: calm ? 0 : Math.abs(Math.sin(t / 160)) * 14 };
      default:
        return { solid: null, lift: 0 };
    }
  }

  private emoteIcon(b: ViewBird, now: number): string | null {
    const e = b.emote;
    if (!e || now - e.start > TUNABLES.chat.emoteMs) return null;
    if (e.e === 'superpose') return reduceMotion() ? '0+1' : null;
    if (e.e === 'collapse') return e.o === undefined ? null : String(e.o);
    return EMOTE_ICONS[e.e] ?? null;
  }

  private drawLandmark(l: Landmark): void {
    const { ctx } = this;
    ctx.fillStyle = l.id === 'flightDeck' ? '#5b2fb0' : '#4a2a92';
    roundRect(ctx, l.x, l.y, l.w, l.h, 28);
    ctx.fill();
    ctx.strokeStyle = l.id === 'flightDeck' ? GOLD : '#8a5cf0';
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 44px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(l.label, l.x + l.w / 2, l.y + l.h / 2);
    ctx.textBaseline = 'alphabetic';
  }

  private showPanel(title: string, ...body: (Node | string | null)[]): void {
    clearInterval(this.panelTimer);
    const close = () => this.closePanel();
    const card = h('div', { class: 'panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'panel-head' }, h('h2', {}, title), h('button', { class: 'btn icon', 'aria-label': 'Close', onclick: close }, '✕')),
      ...body,
    );
    this.panel.replaceChildren(h('div', { class: 'scrim', onclick: close }), card);
    card.querySelector<HTMLButtonElement>('button')?.focus();
  }

  closePanel(): void {
    clearInterval(this.panelTimer);
    this.panel.replaceChildren();
  }

  /** Shows arbitrary content (e.g. the bird editor) as a dialog over the hub. */
  showDialog(content: HTMLElement): void {
    clearInterval(this.panelTimer);
    this.panel.replaceChildren(h('div', { class: 'scrim' }), h('div', { class: 'panel wide' }, content));
  }

  private openGame(kind: 'gateDash' | 'ravens' | 'hall'): void {
    this.closePanel();
    this.closeGame();
    const close = () => this.closeGame();
    this.game = kind === 'gateDash' ? new GateDashView(this.net, close) : kind === 'ravens' ? new RavensView(this.net, close) : new HallView(close);
    this.gameHost.replaceChildren(this.game.root);
  }

  private closeGame(): void {
    if (this.game && !(this.game instanceof HallView)) this.game.destroy();
    this.game = null;
    this.gameHost.replaceChildren();
  }

  private openChat(): void {
    if (this.game) return;
    const send = (msg: ClientMsg) => {
      this.net.send(msg);
      this.closePanel();
    };
    let i = 0;
    this.showPanel(
      'Say something',
      ...PHRASE_GROUPS.flatMap((g) => [
        h('h3', {}, g.label),
        h('div', { class: 'chips' }, ...g.phrases.map((text) => {
          const p = i++;
          return h('button', { class: 'btn chip', onclick: () => send({ t: 'say', p }) }, text);
        })),
      ]),
      h('h3', {}, 'Emotes'),
      h('div', { class: 'chips' }, ...(Object.keys(EMOTE_LABELS) as Emote[]).map((e) =>
        h('button', { class: 'btn chip', onclick: () => send({ t: 'emote', e }) }, EMOTE_LABELS[e]),
      )),
    );
  }

  private openLeaderboard(): void {
    this.showPanel('Top Flock', h('div', { class: 'lb', 'aria-live': 'polite' }, h('p', {}, 'Loading…')));
    this.net.send({ t: 'lbGet' });
    this.panelTimer = window.setInterval(() => this.net.send({ t: 'lbGet' }), TUNABLES.leaderboardRefreshMs);
  }

  private renderLeaderboard(top: LeaderRow[], me: LeaderRow | null): void {
    const host = this.panel.querySelector('.lb');
    if (!host) return;
    const row = (r: LeaderRow, mine: boolean) => {
      const bird = createBirdSvg(`${r.name}'s bird`);
      bird.set({ p0: r.p0 });
      return h('li', { class: mine ? 'lb-row mine' : 'lb-row' },
        h('span', { class: 'lb-rank' }, `#${r.rank}`), bird.el, h('span', { class: 'lb-name' }, r.name), h('span', { class: 'lb-total' }, String(r.total)),
      );
    };
    const inTop = me !== null && me.rank <= top.length;
    host.replaceChildren(
      top.length ? h('ol', { class: 'lb-list' }, ...top.map((r) => row(r, inTop && r.rank === me!.rank))) : h('p', {}, 'No scores yet. Be the first!'),
      me && !inTop ? h('ol', { class: 'lb-list lb-me', 'aria-label': 'Your rank' }, row(me, true)) : '',
      me ? '' : h('p', { class: 'small' }, 'Play a game to get on the board.'),
      h('p', { class: 'small' }, 'Total = best Gate Dash + best Ravens and Robins. Updates every 30 seconds.'),
    );
  }

  private openLandmark(l: Landmark): void {
    if (l.id === 'info') {
      const invite = this.opts.inviteUrl();
      this.showPanel(
        INFO_BOARD.title,
        ...INFO_BOARD.sections.flatMap((s) => [h('h3', {}, s.heading), ...s.lines.map((t) => h('p', {}, t))]),
        invite ? h('a', { class: 'btn', href: invite, target: '_blank', rel: 'noopener' }, 'Open the event Discord') : null,
      );
    } else if (l.id === 'flightDeck') {
      this.showPanel(
        'Flight Deck',
        h('div', { class: 'stack' },
          h('button', { class: 'btn primary', onclick: () => this.openGame('gateDash') }, 'Play Gate Dash'),
          h('p', { class: 'small' }, 'Turn one qubit state into another with X, H and Z. 60 seconds, solo.'),
          h('button', { class: 'btn primary', onclick: () => this.openGame('ravens') }, 'Play Ravens and Robins'),
          h('p', { class: 'small' }, 'Three players: two Robins share a secret, a Raven tries to steal it. About 10 minutes. Practice bots fill empty seats.'),
        ),
      );
    } else if (l.id === 'leaderboard') this.openLeaderboard();
    else if (l.id === 'hall') this.openGame('hall');
    else this.showPanel(l.label, h('p', {}, LANDMARK_SOON[l.id]));
  }

  private goTo(id: Landmark['id']): void {
    const l = LANDMARKS.find((x) => x.id === id)!;
    this.walkTo(l.door.x, l.door.y);
    this.openLandmark(l);
  }

  private openMenu(): void {
    const motion = h('button', {
      class: 'btn',
      onclick: () => {
        setReduceMotion(!reduceMotion());
        motion.textContent = `Reduce motion: ${reduceMotion() ? 'on' : 'off'}`;
      },
    }, `Reduce motion: ${reduceMotion() ? 'on' : 'off'}`);
    this.showPanel(
      'Menu',
      h('div', { class: 'stack' },
        h('button', { class: 'btn', onclick: () => this.opts.onMyBird() }, 'My bird'),
        h('button', { class: 'btn', onclick: () => this.goTo('flightDeck') }, 'Go to the Flight Deck'),
        h('button', { class: 'btn', onclick: () => this.openLeaderboard() }, 'Top Flock leaderboard'),
        h('button', { class: 'btn', onclick: () => this.openGame('hall') }, 'Hall of Pioneers'),
        h('button', { class: 'btn', onclick: () => this.openLandmark(LANDMARKS.find((l) => l.id === 'info')!) }, 'How to play'),
        motion,
        h('button', { class: 'btn', onclick: () => this.opts.onSignOut() }, 'Sign out'),
      ),
    );
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Speech bubble centred above (x, y), wrapped to a readable width. */
function drawBubble(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.save();
  ctx.font = '600 14px system-ui, sans-serif';
  const lines: string[] = [];
  for (const word of text.split(' ')) {
    const last = lines.at(-1);
    if (last && ctx.measureText(`${last} ${word}`).width <= 150) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 20;
  const hgt = lines.length * 18 + 12;
  const top = y - hgt - 8;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#120726';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, top, w, hgt, 10);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 7, top + hgt - 1);
  ctx.lineTo(x, top + hgt + 8);
  ctx.lineTo(x + 7, top + hgt - 1);
  ctx.fill();
  ctx.fillStyle = '#1b0b3a';
  ctx.textAlign = 'center';
  lines.forEach((l, i) => ctx.fillText(l, x, top + 21 + i * 18));
  ctx.restore();
}

/** Admin tools: announcement, and the live list of who is online with mute and kick. Stays open while you walk. */
class AdminDrawer {
  readonly root: HTMLElement;
  private list = h('ul', { class: 'admin-list', 'aria-live': 'off' });
  private status = h('p', { class: 'small', 'aria-live': 'polite' });
  private count = h('span', {});
  private timer: number;
  private net: Net;

  constructor(net: Net, onClose: () => void) {
    this.net = net;
    const text = h('textarea', { class: 'admin-text', maxlength: TUNABLES.announceMax, rows: 2, placeholder: 'Announcement for every player' }) as HTMLTextAreaElement;
    this.root = h('aside', { class: 'admin-drawer', 'aria-label': 'Admin tools' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Admin'), h('button', { class: 'btn icon', 'aria-label': 'Close admin tools', onclick: onClose }, '✕')),
      text,
      h('div', { class: 'chips' },
        h('button', { class: 'btn chip primary', onclick: () => text.value.trim() && net.send({ t: 'adminAnnounce', text: text.value }) }, 'Post'),
        h('button', { class: 'btn chip', onclick: () => net.send({ t: 'adminAnnounce', text: '' }) }, 'Clear banner'),
      ),
      this.status,
      h('h3', {}, 'Online now ', this.count),
      this.list,
    );
    net.send({ t: 'adminList' });
    this.timer = window.setInterval(() => net.send({ t: 'adminList' }), TUNABLES.adminListMs);
  }

  destroy(): void {
    clearInterval(this.timer);
    this.root.remove();
  }

  handle(m: Extract<ServerMsg, { t: 'adminList' | 'adminDone' }>): void {
    if (m.t === 'adminDone') {
      this.status.textContent = m.msg;
      return;
    }
    this.count.textContent = `(${m.players.length})`;
    // Skip the refresh while a button in the list has focus, so a tap is never lost mid-redraw.
    if (this.list.contains(document.activeElement) && document.activeElement !== this.list) return;
    this.list.replaceChildren(...m.players.map((p) => {
      const muted = p.mutedUntil !== null && p.mutedUntil > m.now;
      const mins = muted ? Math.ceil((p.mutedUntil! - m.now) / 60_000) : 0;
      const bird = createBirdSvg(`${p.name}'s bird`);
      bird.set({ p0: p.p0 ?? 50 });
      const act = (label: string, msg: ClientMsg, cls = '') => h('button', { class: `btn chip ${cls}`, onclick: () => this.net.send(msg) }, label);
      return h('li', { class: 'admin-row' },
        bird.el,
        h('div', { class: 'admin-who' },
          h('strong', {}, p.name, p.admin ? ' 🛡' : ''),
          h('span', { class: 'small' }, p.where, muted ? ` · muted ${mins} min` : ''),
        ),
        p.admin ? '' : h('div', { class: 'chips' },
          ...(muted ? [act('Unmute', { t: 'adminMute', ref: p.ref, mins: 0 })]
            : [act('Mute 10m', { t: 'adminMute', ref: p.ref, mins: 10 }), act('1h', { t: 'adminMute', ref: p.ref, mins: 60 }), act('24h', { t: 'adminMute', ref: p.ref, mins: 1440 })]),
          h('button', { class: 'btn chip danger', onclick: () => confirm(`Disconnect ${p.name}?`) && this.net.send({ t: 'adminKick', ref: p.ref }) }, 'Kick'),
        ),
      );
    }));
  }
}
