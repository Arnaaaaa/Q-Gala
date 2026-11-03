import { TUNABLES } from './tunables.ts';

const ALLOWED = /^[A-Za-z0-9 _-]+$/;

// Look-alikes folded together when checking uniqueness.
const LOOKALIKES: Record<string, string> = {
  '0': 'o', '1': 'l', 'i': 'l', '3': 'e', '4': 'a', '5': 's',
  '7': 't', '8': 'b', '9': 'g', '2': 'z',
};

export function cleanName(raw: string): string {
  return raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** Returns a friendly error, or null if the format is fine. */
export function nameFormatError(name: string): string | null {
  const { min, max } = TUNABLES.name;
  if (name.length < min || name.length > max) return `Names need ${min} to ${max} characters.`;
  if (!ALLOWED.test(name)) return 'Use only letters, digits, spaces, _ and -.';
  if (!/[A-Za-z0-9]/.test(name)) return 'Include at least one letter or digit.';
  return null;
}

/** Canonical form for uniqueness: case, spaces, _ and - and look-alikes ignored. */
export function normalizeName(name: string): string {
  let n = name.normalize('NFKC').toLowerCase().replace(/[\s_-]/g, '');
  n = n.replace(/rn/g, 'm').replace(/vv/g, 'w');
  return [...n].map((c) => LOOKALIKES[c] ?? c).join('');
}

/** Best-effort pre-fill from a Discord display name. */
export function suggestName(display: string): string {
  const s = cleanName(display.normalize('NFKD').replace(/[^A-Za-z0-9 _-]/g, '')).slice(0, TUNABLES.name.max).trim();
  return nameFormatError(s) ? '' : s;
}
