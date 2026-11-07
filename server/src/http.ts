import { normalizeName } from '../../shared/names.ts';
import { randomId, signSession } from './auth.ts';
import { config, discordConfigured } from './config.ts';
import type { Db } from './db.ts';
import { authorizeUrl, DiscordDown, exchangeCode, fetchMembership, revokeToken } from './discord.ts';
import type { Game } from './game.ts';

const STATE_TTL = 10 * 60_000;
const TICKET_TTL = 60_000;

// OAuth `state` values and one-time login tickets live only in memory; a restart
// mid-login just means the player presses the button again. Expired entries are
// swept on requests rather than by an interval, which would keep a Durable Object awake.
const states = new Map<string, number>();
const tickets = new Map<string, { token: string; suggestedName: string; exp: number }>();
let swept = 0;

function sweep(now: number): void {
  if (now - swept < 60_000) return;
  swept = now;
  for (const [k, exp] of states) if (exp < now) states.delete(k);
  for (const [k, t] of tickets) if (t.exp < now) tickets.delete(k);
}

const started = Date.now();

/** Plain fetch-style handler: runs unchanged on Node (via index.ts) and in the Durable Object (worker.ts). */
export function createHttpHandler(db: Db, game: Game) {
  /** Starts a new session (ending any older one) and sends the browser back with a one-time ticket. */
  function finishLogin(uid: string, suggestedName: string): Response {
    if (db.getUser(uid)?.banned) return redirectToClient('error=banned');
    const sid = randomId();
    db.upsertLogin(uid, sid, config.testAccountIds.includes(uid));
    game.endSessionsFor(uid, 'replaced');
    const token = signSession({ uid, sid, exp: Date.now() + config.sessionMs }, config.sessionSecret);
    const ticket = randomId(24);
    tickets.set(ticket, { token, suggestedName, exp: Date.now() + TICKET_TTL });
    return redirectToClient(`ticket=${ticket}`);
  }

  async function discordCallback(q: URLSearchParams): Promise<Response> {
    const state = q.get('state') ?? '';
    const stateExp = states.get(state);
    states.delete(state);
    if (q.get('error')) return redirectToClient('error=denied');
    const code = q.get('code');
    if (!code || !stateExp || stateExp < Date.now()) return redirectToClient('error=expired');
    try {
      const access = await exchangeCode(code);
      if (!access) return redirectToClient('error=expired');
      const member = await fetchMembership(access).finally(() => revokeToken(access));
      if (!member) return redirectToClient('error=not_member');
      const need = config.discord.requiredRoleIds;
      if (need.length > 0 && !need.some((r) => member.roles.includes(r))) {
        return redirectToClient('error=missing_role');
      }
      return finishLogin(member.userId, member.displayName);
    } catch (e) {
      if (e instanceof DiscordDown) return redirectToClient('error=discord_down');
      throw e;
    }
  }

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;
    const allow = corsHeaders(req);
    sweep(Date.now());
    try {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: allow });
      switch (route) {
        case 'GET /health':
          return json(200, { ok: true, online: game.online, uptimeS: Math.round((Date.now() - started) / 1000) });
        case 'GET /api/public':
          return json(200, { inviteUrl: config.discord.inviteUrl, devLogin: config.devLogin, discord: discordConfigured() }, allow);
        case 'GET /auth/discord/start': {
          if (!discordConfigured()) return redirectToClient('error=discord_down');
          const state = randomId();
          states.set(state, Date.now() + STATE_TTL);
          return redirect(authorizeUrl(state));
        }
        case 'GET /auth/discord/callback':
          return await discordCallback(url.searchParams);
        case 'POST /auth/exchange': {
          const body = await readJson(req);
          const t = typeof body?.ticket === 'string' ? tickets.get(body.ticket) : undefined;
          if (!t || t.exp < Date.now()) return json(401, { error: 'expired' }, allow);
          tickets.delete(body!.ticket as string);
          return json(200, { token: t.token, suggestedName: t.suggestedName }, allow);
        }
        case 'GET /auth/dev':
          if (!config.devLogin) break;
          return finishLogin(devUid(url.searchParams.get('name')), url.searchParams.get('name') ?? '');
        case 'POST /auth/dev-token': {
          // Used by the load test. Only exists with DEV_LOGIN=1.
          if (!config.devLogin) break;
          const body = await readJson(req);
          const uid = devUid(String(body?.id ?? ''));
          const sid = randomId();
          db.upsertLogin(uid, sid, true);
          return json(200, { token: signSession({ uid, sid, exp: Date.now() + config.sessionMs }, config.sessionSecret) });
        }
      }
      return json(404, { error: 'not found' });
    } catch (e) {
      console.error('http error', route, e instanceof Error ? e.message : e);
      return json(500, { error: 'server error' });
    }
  };
}

const devUid = (name: string | null) => 'dev-' + (normalizeName(name ?? '').slice(0, 24) || randomId(6));

/** Only the Pages origin may call the API from a browser. */
export const originAllowed = (req: Request) => config.allowedOrigins.includes(req.headers.get('Origin') ?? '');

function corsHeaders(req: Request): Record<string, string> {
  if (!originAllowed(req)) return {};
  return {
    'Access-Control-Allow-Origin': req.headers.get('Origin')!,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST',
    Vary: 'Origin',
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store' } });
}

/** The fragment never reaches any server, and the client strips it from the address bar. */
function redirectToClient(fragment: string): Response {
  return redirect(`${config.clientUrl}/#${fragment}`);
}

async function readJson(req: Request, limit = 4096): Promise<Record<string, unknown> | null> {
  const text = await req.text().catch(() => '');
  if (text.length > limit) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}
