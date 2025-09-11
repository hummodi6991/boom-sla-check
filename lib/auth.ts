import { SignJWT, jwtVerify } from 'jose';

const COOKIE = 'boom_session';
const secret = new TextEncoder().encode(process.env.AUTH_SECRET || 'dev-secret');

export type Session = { sub: string; email: string; name?: string | null };

function readCookie(h: Headers, name: string) {
  const raw = h.get('cookie') || '';
  const m = raw.match(new RegExp(`${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export async function getSession(headers: Headers) {
  const token = readCookie(headers, COOKIE);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret);
    return payload as Session;
  } catch {
    return null;
  }
}

export async function createSessionCookie(session: Session) {
  const token = await new SignJWT(session)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret);

  const base = `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`;
  return process.env.NODE_ENV === 'production' ? `${base}; Secure` : base;
}

export function clearSessionCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

