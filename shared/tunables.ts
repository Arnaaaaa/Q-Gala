// Every tunable number lives here (spec §6). Secrets and deployment settings
// live in server environment variables instead (see server/src/config.ts).
export const TUNABLES = {
  sessionHours: 12,
  authTimeoutMs: 10_000,
  name: { min: 3, max: 16 },
  avatarChangeIntervalMs: 60_000,
  p0Step: 5,
  chat: {
    intervalMs: 2_000, // one phrase or emote per player per 2 s
    bubbleMs: 4_000,
    emoteMs: 2_000,
  },
  gateDash: {
    runMs: 60_000,
    pointsPerLevel: 10,
    minGatesBonus: 5,
    minTapGapMs: 150,
    timingSlackMs: 1_000, // network allowance when checking a level's tap times
    maxGates: 20,
    threeGateShare: 0.5, // from level 8, share of levels needing 3 gates
  },
  // Ravens and Robins (spec D7). Every number here is a tunable default.
  rr: {
    notes: 32,
    maxIntercepts: 16,
    rounds: 3,
    launchMs: 3_000,
    chooseMs: 20_000,
    compareMs: 15_000,
    verdictMs: 20_000,
    resultMs: 9_000,
    botWaitMs: 20_000,
    storms: [0, 0.03, 0.06],
    forecastHalfWidthPct: 3, // forecast shows storm ± this, clamped at 0
    sample: { min: 4, max: 10, default: 6 },
    botAbortMarginPct: 10,
    botRavenAggression: 16, // bot Raven intercepts 0..this many notes
    // Spec default ravenPerLearnedBit is 2; calibration (README) raised it to 4 so Ravens can win; approved 30 Oct 2026.
    points: { robinPerSafeBit: 1, ravenPerLearnedBit: 4, spyFoiled: 10, bluff: 5 },
  },
  leaderboardRefreshMs: 30_000,
  hub: {
    capacity: 250,
    viewRadius: 1400, // world units, about 1.5 screens
    viewSpan: 900, // world units across the longer screen side
    maxVisible: 60,
    walkSpeed: 260, // world units per second
    tickMs: 500, // interest management and idle checks
    syncMs: 4_000, // corrective position sync
    onlineMs: 2_000, // "N birds online" refresh
    idleFadeMs: 10 * 60_000,
    idleKickMs: 20 * 60_000,
  },
  // Per-connection token buckets, per client message type.
  rate: {
    auth: { perSec: 0.5, burst: 3 },
    claimName: { perSec: 0.5, burst: 3 },
    setBird: { perSec: 0.5, burst: 3 },
    joinHub: { perSec: 0.5, burst: 3 },
    move: { perSec: 5, burst: 6 },
    ping: { perSec: 1, burst: 3 },
    say: { perSec: 1, burst: 2 },
    emote: { perSec: 1, burst: 2 },
    gdStart: { perSec: 0.5, burst: 3 },
    gdSolve: { perSec: 5, burst: 8 },
    gdQuit: { perSec: 1, burst: 3 },
    lbGet: { perSec: 1, burst: 3 },
    rrJoin: { perSec: 0.5, burst: 3 },
    rrLeave: { perSec: 1, burst: 3 },
    rrWinds: { perSec: 5, burst: 10 },
    rrIntercept: { perSec: 5, burst: 10 },
    rrSample: { perSec: 1, burst: 3 },
    rrReact: { perSec: 1, burst: 3 },
    rrVerdict: { perSec: 1, burst: 3 },
  } as Record<string, { perSec: number; burst: number }>,
  reconnect: { baseMinMs: 1_000, baseMaxMs: 3_000, capMs: 30_000 },
};
