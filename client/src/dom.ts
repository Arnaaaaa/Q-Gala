type Child = Node | string | null | undefined | false;
type Attrs = Record<string, unknown>;

/**
 * Tiny element builder. Strings become text nodes, so player names and other
 * text are always escaped; never use innerHTML with game data.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c != null && c !== false) el.append(c);
  return el;
}

export function mount(...nodes: Node[]): void {
  document.getElementById('app')!.replaceChildren(...nodes);
  window.scrollTo(0, 0);
}

export function screen(...children: Child[]): HTMLElement {
  return h('section', { class: 'screen' }, h('div', { class: 'card' }, ...children));
}
