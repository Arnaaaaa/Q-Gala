// Per-device preferences. Storage can be unavailable (private mode), so every access is guarded.
const KEY = 'qg.reduceMotion';
const media = window.matchMedia('(prefers-reduced-motion: reduce)');

function load(): boolean | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === null ? null : v === '1';
  } catch {
    return null;
  }
}

let override = load();

export function reduceMotion(): boolean {
  return override ?? media.matches;
}

export function setReduceMotion(v: boolean): void {
  override = v;
  try {
    localStorage.setItem(KEY, v ? '1' : '0');
  } catch {}
  applyPrefs();
}

export function applyPrefs(): void {
  document.documentElement.classList.toggle('reduce-motion', reduceMotion());
}

media.addEventListener('change', applyPrefs);

export const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
  del(k: string): void {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};
