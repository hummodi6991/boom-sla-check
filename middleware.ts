import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';
import { jwtVerify } from 'jose';

const COOKIE = 'boom_session';
const secret = new TextEncoder().encode(process.env.AUTH_SECRET || 'dev-secret');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function middleware(req: NextRequest) {
  const url = new URL(req.url);
  const { pathname, searchParams } = url;

  // Legacy: /inbox?cid=<uuid or id>
  if (pathname === '/inbox' && searchParams.has('cid')) {
    const cid = searchParams.get('cid')!;
    if (UUID_RE.test(cid)) {
      const to = new URL('/dashboard/guest-experience/all', url.origin);
      to.searchParams.set('conversation', cid);
      return NextResponse.redirect(to, 308);
    }
  }

  // Legacy: /inbox/conversations/:id
  const convoMatch = pathname.match(/^\/inbox\/conversations\/([^/]+)$/);
  if (convoMatch) {
    const id = convoMatch[1];
    if (UUID_RE.test(id)) {
      const to = new URL('/dashboard/guest-experience/all', url.origin);
      to.searchParams.set('conversation', id);
      return NextResponse.redirect(to, 308);
    }
  }

  if (!pathname.startsWith('/inbox')) return NextResponse.next();

  const dest = convoMatch ? `/inbox?cid=${encodeURIComponent(convoMatch[1])}` : pathname + url.search;
  const token = req.cookies.get(COOKIE)?.value;
  if (!token) {
    const loginUrl = new URL('/login', url);
    loginUrl.search = `?next=${encodeURIComponent(dest)}`;
    return NextResponse.redirect(loginUrl);
  }
  try {
    await jwtVerify(token, secret);
    return NextResponse.next();
  } catch {
    const loginUrl = new URL('/login', url);
    loginUrl.search = `?next=${encodeURIComponent(dest)}`;
    return NextResponse.redirect(loginUrl);
  }
}

export const config = { matcher: ['/inbox/:path*'] };
