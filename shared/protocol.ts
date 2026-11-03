// WebSocket message shapes shared by client and server.
import type { Gate, QState } from './gates.ts';
import type { Emote } from './phrases.ts';

export type Wind = 'A' | 'B';
export type Bit = 0 | 1;
export type RrRole = 'sender' | 'receiver' | 'raven';
export type RrPhase = 'launch' | 'choose' | 'compare' | 'verdict' | 'result';
export type RrReaction = 'fine' | 'raven';

export type ClientMsg =
  | { t: 'auth'; token: string }
  | { t: 'claimName'; name: string }
  | { t: 'setBird'; p0: number }
  | { t: 'joinHub' }
  | { t: 'move'; x: number; y: number }
  | { t: 'ping' }
  | { t: 'say'; p: number }
  | { t: 'emote'; e: Emote }
  | { t: 'gdStart' }
  // Gates tapped since the level appeared (or the last reset), with ms between taps.
  | { t: 'gdSolve'; level: number; gates: Gate[]; dts: number[] }
  | { t: 'gdQuit' }
  | { t: 'lbGet' }
  | { t: 'rrJoin' }
  | { t: 'rrLeave' }
  // Choices may be sent repeatedly while editing; `done` means the player is ready.
  | { t: 'rrWinds'; winds: Wind[]; done: boolean }
  | { t: 'rrIntercept'; notes: number[]; guesses: Wind[]; done: boolean }
  | { t: 'rrSample'; k: number }
  | { t: 'rrReact'; r: RrReaction }
  | { t: 'rrVerdict'; v: 'trust' | 'abort' };

export type LeaderRow = { rank: number; name: string; p0: number; total: number };

export type Profile = { name: string | null; p0: number | null };

/** A bird as other players see it. `id` is a per-session public id, never the Discord ID. */
export type BirdDTO = { id: string; name: string; p0: number; x: number; y: number; tx: number; ty: number; idle: boolean };

export type KickCode = 'auth' | 'replaced' | 'banned' | 'full' | 'idle' | 'kicked';

export type RrSeat = { name: string; p0: number; bot: boolean; score: number };

export type ServerMsg =
  | { t: 'welcome'; profile: Profile }
  | { t: 'nameResult'; ok: true; name: string }
  | { t: 'nameResult'; ok: false; reason: string }
  | { t: 'birdResult'; ok: true; p0: number }
  | { t: 'birdResult'; ok: false; reason: string; retryInMs?: number }
  | { t: 'hubState'; you: BirdDTO; online: number }
  | { t: 'enter'; bird: BirdDTO }
  | { t: 'leave'; id: string }
  | { t: 'moved'; id: string; x: number; y: number; tx: number; ty: number }
  | { t: 'sync'; b: [id: string, x: number, y: number, tx: number, ty: number][] }
  | { t: 'idle'; id: string; idle: boolean }
  | { t: 'birdChanged'; id: string; p0: number }
  | { t: 'online'; n: number }
  | { t: 'kicked'; code: KickCode }
  | { t: 'error'; msg: string }
  | { t: 'pong' }
  | { t: 'said'; id: string; p: number }
  // `o` is the server-drawn outcome for the Collapse emote.
  | { t: 'emoted'; id: string; e: Emote; o?: 0 | 1 }
  | { t: 'gdLevel'; level: number; start: QState; target: QState; min: number; gates: Gate[]; msLeft: number; score: number; gained: number }
  | { t: 'gdEnd'; score: number; best: number; newBest: boolean }
  | { t: 'leaderboard'; top: LeaderRow[]; me: LeaderRow | null; total: number }
  // Ravens and Robins. Each message goes only to the players allowed to see it (see server/src/ravens.ts).
  | { t: 'rrQueued'; botInMs: number }
  | { t: 'rrMatch'; seats: RrSeat[]; you: number; rounds: number }
  | { t: 'rrSeats'; seats: RrSeat[] }
  | { t: 'rrRound'; round: number; roles: Record<RrRole, number>; you: RrRole }
  | { t: 'rrPhase'; phase: RrPhase; msLeft: number }
  | { t: 'rrSecret'; bits: Bit[]; winds: Wind[] } // Sender only
  | { t: 'rrDefaults'; winds: Wind[] } // Receiver: pre-filled winds. Raven: pre-filled guesses.
  | { t: 'rrRead'; reads: [note: number, bit: Bit][] } // Raven only: what she read
  | { t: 'rrCompare'; senderWinds: Wind[]; receiverWinds: Wind[]; kept: number[] }
  | { t: 'rrSampled'; notes: number[]; senderBits: Bit[]; receiverBits: Bit[]; disagree: number; forecast: [lo: number, hi: number] }
  | { t: 'rrReaction'; r: RrReaction } // Receiver only
  | {
      t: 'rrResult';
      verdict: 'trust' | 'abort';
      outcome: 'trusted' | 'foiled' | 'falseAlarm';
      intercepted: number[];
      learned: number[];
      key: number[];
      points: number[]; // per seat this round
    }
  | { t: 'rrEnd'; seats: RrSeat[]; you: number; best: number; newBest: boolean };
