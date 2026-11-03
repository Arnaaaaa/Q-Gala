import type { ClientMsg, Wind } from '../../shared/protocol.ts';
import { TUNABLES } from '../../shared/tunables.ts';
import { GATES, type Gate } from '../../shared/gates.ts';
import { EMOTES, PHRASES, type Emote } from '../../shared/phrases.ts';

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const coord = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 100_000;
const int = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const isGate = (v: unknown): v is Gate => GATES.includes(v as Gate);
const R = TUNABLES.rr;
const winds = (v: unknown, len: number): v is Wind[] => Array.isArray(v) && v.length === len && v.every((w) => w === 'A' || w === 'B');
const p0 = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100 && (v as number) % TUNABLES.p0Step === 0;

/** Returns a clean message object, or null for anything malformed or unknown (which is dropped). */
export function parseClientMsg(raw: unknown): ClientMsg | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  switch (m.t) {
    case 'auth':
      return str(m.token, 1024) ? { t: 'auth', token: m.token } : null;
    case 'claimName':
      return str(m.name, 64) ? { t: 'claimName', name: m.name } : null;
    case 'setBird':
      return p0(m.p0) ? { t: 'setBird', p0: m.p0 } : null;
    case 'joinHub':
      return { t: 'joinHub' };
    case 'move':
      return coord(m.x) && coord(m.y) ? { t: 'move', x: Math.round(m.x), y: Math.round(m.y) } : null;
    case 'ping':
      return { t: 'ping' };
    case 'say':
      return int(m.p, 0, PHRASES.length - 1) ? { t: 'say', p: m.p } : null;
    case 'emote':
      return EMOTES.includes(m.e as Emote) ? { t: 'emote', e: m.e as Emote } : null;
    case 'gdStart':
      return { t: 'gdStart' };
    case 'gdSolve': {
      const { level, gates, dts } = m;
      const max = TUNABLES.gateDash.maxGates;
      if (!int(level, 1, 10_000) || !Array.isArray(gates) || !Array.isArray(dts)) return null;
      if (gates.length > max || dts.length > max || !gates.every(isGate) || !dts.every((d) => int(d, 0, 600_000))) return null;
      return { t: 'gdSolve', level, gates, dts };
    }
    case 'gdQuit':
      return { t: 'gdQuit' };
    case 'lbGet':
      return { t: 'lbGet' };
    case 'rrJoin':
      return { t: 'rrJoin' };
    case 'rrLeave':
      return { t: 'rrLeave' };
    case 'rrWinds':
      return winds(m.winds, R.notes) && typeof m.done === 'boolean' ? { t: 'rrWinds', winds: m.winds, done: m.done } : null;
    case 'rrIntercept': {
      const { notes, guesses, done } = m;
      if (!Array.isArray(notes) || notes.length > R.maxIntercepts || !notes.every((n) => int(n, 0, R.notes - 1))) return null;
      return winds(guesses, notes.length) && typeof done === 'boolean' ? { t: 'rrIntercept', notes, guesses, done } : null;
    }
    case 'rrSample':
      return int(m.k, R.sample.min, R.sample.max) ? { t: 'rrSample', k: m.k } : null;
    case 'rrReact':
      return m.r === 'fine' || m.r === 'raven' ? { t: 'rrReact', r: m.r } : null;
    case 'rrVerdict':
      return m.v === 'trust' || m.v === 'abort' ? { t: 'rrVerdict', v: m.v } : null;
    default:
      return null;
  }
}
