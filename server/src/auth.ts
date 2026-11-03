import crypto from 'node:crypto';

export type Session = { uid: string; sid: string; exp: number };

const mac = (body: string, secret: string) => crypto.createHmac('sha256', secret).update(body).digest('base64url');

export const randomId = (bytes = 16) => crypto.randomBytes(bytes).toString('base64url');

export function signSession(s: Session, secret: string): string {
  const body = Buffer.from(JSON.stringify(s)).toString('base64url');
  return `${body}.${mac(body, secret)}`;
}

export function verifySession(token: string, secret: string, now = Date.now()): Session | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = Buffer.from(mac(body, secret));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString()) as Session;
    if (typeof s.uid !== 'string' || typeof s.sid !== 'string' || typeof s.exp !== 'number') return null;
    return s.exp > now ? s : null;
  } catch {
    return null;
  }
}
