import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';

export function middleware(req: NextRequest) {
  const u = new URL(req.url);
  if (u.pathname === '/inbox' && u.searchParams.has('cid')) {
    const cid = u.searchParams.get('cid')!;
    return NextResponse.redirect(new URL(`/c/${cid}`, u.origin), 308);
  }
  const m = u.pathname.match(/^\/inbox\/conversations\/([^/]+)$/);
  if (m) return NextResponse.redirect(new URL(`/c/${m[1]}`, u.origin), 308);
  return NextResponse.next();
}

export const config = { matcher: ['/inbox/:path*'] };
