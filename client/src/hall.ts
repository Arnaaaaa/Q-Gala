import { GOLD, INDIGO, VIOLET } from '../../shared/colors.ts';
import { h } from './dom.ts';

type Pioneer = { name: string; known: string; story?: string; initials?: string; findIt?: string | null };

let pioneers: Promise<Pioneer[]> | null = null;

/** Loads public/content/pioneers.json, which organizers edit without touching code. */
function loadPioneers(): Promise<Pioneer[]> {
  pioneers ??= fetch(`${import.meta.env.BASE_URL}content/pioneers.json`, { cache: 'no-cache' })
    .then((r) => r.json() as Promise<{ pioneers: Pioneer[] }>)
    .then((j) => j.pioneers.filter((p) => p?.name && p?.known))
    .catch(() => ((pioneers = null), []));
  return pioneers;
}

/** "Charles Bennett and Gilles Brassard" → "CB·GB": first and last initial of each person. */
export function initialsOf(name: string): string {
  return name
    .split(/,\s*(?:and\s+)?|\s+and\s+/)
    .map((person) => {
      const words = person.trim().split(/\s+/).filter(Boolean);
      return words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0]?.[0] ?? '');
    })
    .join('·')
    .toUpperCase();
}

const NS = 'http://www.w3.org/2000/svg';
let seq = 0;

/** Original bird-style badge with the pioneer's initials. No photos, no external images. */
function badge(initials: string): SVGSVGElement {
  const id = `hall-grad-${seq++}`;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('class', 'hall-badge');
  svg.setAttribute('aria-hidden', 'true');
  const fontSize = initials.length > 5 ? 15 : initials.length > 2 ? 20 : 30;
  // Static markup with no player data in it; initials are set as text below.
  svg.innerHTML = `
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${INDIGO}"/><stop offset="1" stop-color="${VIOLET}"/></linearGradient></defs>
    <path d="M14 58 L2 44 L6 64 Z" fill="${VIOLET}" stroke="#120726" stroke-width="2"/>
    <circle cx="50" cy="54" r="38" fill="url(#${id})" stroke="#120726" stroke-width="3"/>
    <path d="M84 40 L98 46 L84 52 Z" fill="${GOLD}" stroke="#120726" stroke-width="2"/>
    <circle cx="72" cy="34" r="3.5" fill="#120726"/>
    <text x="48" y="${62 + fontSize / 6}" text-anchor="middle" font-family="system-ui, sans-serif" font-weight="800" font-size="${fontSize}" fill="#fff" stroke="#120726" stroke-width="3" paint-order="stroke"></text>`;
  svg.querySelector('text')!.textContent = initials;
  return svg;
}

/** The Hall of Pioneers gallery: one card per row on phones, a grid on wider screens. */
export class HallView {
  readonly root = h('div', { class: 'game hall', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Hall of Pioneers' });
  private onClose: () => void;
  private list: Pioneer[] = [];

  constructor(onClose: () => void) {
    this.onClose = onClose;
    this.root.append(this.header('Hall of Pioneers', 'Close the Hall', onClose), h('p', {}, 'Loading…'));
    void loadPioneers().then((list) => {
      this.list = list;
      this.showGallery();
    });
  }

  private header(title: string, closeLabel: string, onClose: () => void): HTMLElement {
    return h('header', { class: 'gd-head' }, h('button', { class: 'btn icon', 'aria-label': closeLabel, onclick: onClose }, closeLabel.startsWith('Back') ? '←' : '✕'), h('h2', {}, title), h('span', {}));
  }

  private showGallery(): void {
    const body = this.list.length
      ? h('ul', { class: 'hall-grid' }, ...this.list.map((p, i) =>
          h('li', {}, h('button', { class: 'hall-card', onclick: () => this.showDetail(i) },
            badge(p.initials || initialsOf(p.name)),
            h('span', { class: 'hall-text' },
              h('strong', {}, p.name),
              h('span', {}, p.known),
              p.findIt ? h('span', { class: 'hall-tag' }, `Find it in Q-Gala: ${p.findIt}`) : '',
            ),
          )),
        ))
      : h('p', {}, 'The Hall is empty right now. Please try again later.');
    this.root.replaceChildren(this.header('Hall of Pioneers', 'Close the Hall', this.onClose), h('p', { class: 'small' }, 'People whose ideas made quantum computing possible. Tap a card to read more.'), body);
  }

  private showDetail(i: number): void {
    const p = this.list[i];
    this.root.replaceChildren(
      this.header(p.name, 'Back to the Hall', () => this.showGallery()),
      h('article', { class: 'hall-detail' },
        badge(p.initials || initialsOf(p.name)),
        h('p', { class: 'lead' }, p.known),
        p.story ? h('p', {}, p.story) : '',
        p.findIt ? h('p', { class: 'hall-tag' }, `Find it in Q-Gala: ${p.findIt}`) : '',
      ),
      h('button', { class: 'btn', onclick: () => this.showGallery() }, 'Back to the Hall'),
    );
    this.root.scrollTop = 0;
  }
}
