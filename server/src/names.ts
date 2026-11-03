import { cleanName, nameFormatError, normalizeName } from '../../shared/names.ts';
import { BLOCKED_WORDS, RESERVED_NAMES } from './blocklist.ts';

export type NameCheck = { ok: true; name: string; norm: string } | { ok: false; reason: string };

const BLOCKED = BLOCKED_WORDS.map(normalizeName);

export function checkName(raw: string, extraReserved: string[] = []): NameCheck {
  const name = cleanName(raw);
  const err = nameFormatError(name);
  if (err) return { ok: false, reason: err };
  const norm = normalizeName(name);
  // Short reserved words must match exactly; longer ones also block names containing them.
  const reserved = [...RESERVED_NAMES, ...extraReserved].map(normalizeName);
  if (reserved.some((r) => norm === r || (r.length >= 4 && norm.includes(r)))) {
    return { ok: false, reason: 'That name is reserved. Please try another one.' };
  }
  if (BLOCKED.some((w) => norm.includes(w))) {
    return { ok: false, reason: 'That name is not allowed. Please try another one.' };
  }
  return { ok: true, name, norm };
}
