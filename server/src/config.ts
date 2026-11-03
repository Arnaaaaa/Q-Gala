import { TUNABLES } from '../../shared/tunables.ts';

const env = (k: string, d = '') => process.env[k]?.trim() || d;
const list = (k: string) => env(k).split(',').map((s) => s.trim()).filter(Boolean);

const clientUrl = env('CLIENT_URL', 'http://localhost:5173').replace(/\/$/, '');
const devLogin = env('DEV_LOGIN') === '1';
const sessionSecret = env('SESSION_SECRET');

if (!devLogin && sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET must be set (at least 32 characters) outside dev mode.');
}

export const config = {
  port: Number(env('PORT', '8080')),
  publicUrl: env('PUBLIC_URL', 'http://localhost:8080').replace(/\/$/, ''),
  clientUrl,
  allowedOrigins: [new URL(clientUrl).origin],
  sessionSecret: sessionSecret || 'dev-only-insecure-secret-dev-only-insecure',
  sessionMs: TUNABLES.sessionHours * 3600_000,
  dbPath: env('DB_PATH', './q-gala.db'),
  devLogin,
  discord: {
    clientId: env('DISCORD_CLIENT_ID'),
    clientSecret: env('DISCORD_CLIENT_SECRET'),
    guildId: env('DISCORD_GUILD_ID'),
    requiredRoleId: env('DISCORD_REQUIRED_ROLE_ID'),
    inviteUrl: env('DISCORD_INVITE_URL', 'https://discord.com'),
  },
  adminIds: list('ADMIN_IDS'),
  testAccountIds: list('TEST_ACCOUNT_IDS'),
  reservedNames: list('RESERVED_NAMES'),
};

export const discordConfigured = () => Boolean(config.discord.clientId && config.discord.clientSecret && config.discord.guildId);
