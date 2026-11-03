import { h } from './dom.ts';

export type Card = { title: string; text: string };
export type CardKey = 'avatar' | 'gateDash' | 'ravens';

let cards: Promise<Record<string, unknown>> | null = null;

/** Loads public/content/cards.json, which organizers edit without touching code. */
function load(): Promise<Record<string, unknown>> {
  cards ??= fetch(`${import.meta.env.BASE_URL}content/cards.json`, { cache: 'no-cache' })
    .then((r) => r.json() as Promise<Record<string, unknown>>)
    .catch(() => ((cards = null), {}));
  return cards;
}

const isCard = (c: unknown): c is Card => !!c && typeof (c as Card).title === 'string' && typeof (c as Card).text === 'string';

export async function getCard(key: CardKey): Promise<Card | null> {
  const c = (await load())[key];
  return isCard(c) ? c : null;
}

/** The five Ravens and Robins intro cards shown before a player's first match. */
export async function getIntro(): Promise<Card[]> {
  const list = (await load()).ravensIntro;
  return Array.isArray(list) ? list.filter(isCard) : [];
}

export function cardView(c: Card): HTMLElement {
  return h('aside', { class: 'learn-card' }, h('p', { class: 'learn-kicker' }, 'Learning card'), h('h3', {}, c.title), h('p', {}, c.text));
}
