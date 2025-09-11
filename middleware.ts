import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';
import { jwtVerify } from 'jose';
const COOKIE = 'boom_session';
const secret = new TextEncoder().encode(process.env.AUTH_SECRET || 'dev-secret');

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (!pathname.startsWith('/inbox')) return NextResponse.next();

  const token = req.cookies.get(COOKIE)?.value;
  if (!token) {
    const url = new URL('/login', req.url);
    url.search = `?next=${pathname}${search}`;
    return NextResponse.redirect(url);
  }
  try { await jwtVerify(token, secret); return NextResponse.next(); }
  catch {
    const url = new URL('/login', req.url);
    url.search = `?next=${pathname}${search}`;
    return NextResponse.redirect(url);
  }
}
export const config = { matcher: ['/inbox/:path*'] };
