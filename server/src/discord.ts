import { config } from './config.ts';

// Scopes: `identify` for the user ID, `guilds.members.read` to read only the
// caller's membership of the one event server (not their full server list).
const API = 'https://discord.com/api/v10';
const SCOPES = 'identify guilds.members.read';
const TIMEOUT = 8_000;

export class DiscordDown extends Error {}

export const redirectUri = () => `${config.publicUrl}/auth/discord/callback`;

export function authorizeUrl(state: string): string {
  const q = new URLSearchParams({
    client_id: config.discord.clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    scope: SCOPES,
    state,
    prompt: 'none',
  });
  return `https://discord.com/oauth2/authorize?${q}`;
}

async function call(url: string, init: RequestInit): Promise<Response> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
    if (res.status >= 500 || res.status === 429) throw new DiscordDown(`Discord ${res.status}`);
    return res;
  } catch (e) {
    throw e instanceof DiscordDown ? e : new DiscordDown(String(e));
  }
}

const basicAuth = () => 'Basic ' + Buffer.from(`${config.discord.clientId}:${config.discord.clientSecret}`).toString('base64');

export async function exchangeCode(code: string): Promise<string | null> {
  const res = await call('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth() },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { access_token?: string };
  return json.access_token ?? null;
}

export type Membership = { userId: string; displayName: string; roles: string[] } | null;

/** Returns null when the user is not a member of the event server. */
export async function fetchMembership(accessToken: string): Promise<Membership> {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const res = await call(`${API}/users/@me/guilds/${config.discord.guildId}/member`, { headers });
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new DiscordDown(`member lookup ${res.status}`);
  const m = (await res.json()) as { nick?: string | null; roles?: string[]; user?: { id: string; username: string; global_name?: string | null } };
  if (!m.user?.id) throw new DiscordDown('member lookup returned no user');
  return { userId: m.user.id, displayName: m.nick || m.user.global_name || m.user.username, roles: m.roles ?? [] };
}

/** Best effort: we never store Discord tokens, and revoke them right after use. */
export async function revokeToken(accessToken: string): Promise<void> {
  await call('https://discord.com/api/oauth2/token/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth() },
    body: new URLSearchParams({ token: accessToken, token_type_hint: 'access_token' }),
  }).catch(() => {});
}
