import { SignJWT, jwtVerify } from 'jose';

const COOKIE_NAME = 'boom_session';
const secret = new TextEncoder().encode(process.env.AUTH_SECRET || 'dev-secret');

export type Session = { sub: string; email: string; name?: string | null };

function readCookie(headers: Headers, name: string) {
  const cookie = headers.get('cookie') || '';
  const m = cookie.match(new RegExp(`${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export async function getSession(headers: Headers) {
  const token = readCookie(headers, COOKIE_NAME);
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

  const base = `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`;
  return process.env.NODE_ENV === 'production' ? `${base}; Secure` : base;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

