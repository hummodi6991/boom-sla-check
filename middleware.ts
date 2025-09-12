import { NextResponse } from 'next/server.js';

export function middleware(req: Request) {
  const url = new URL(req.url);
  const path = url.pathname;

  // Bypass redirects/rewrite for health checks and redirector
  if (path.startsWith('/_health') || path.startsWith('/r/')) return NextResponse.next();

  if (path === '/inbox' && url.searchParams.has('cid')) {
    const cid = url.searchParams.get('cid')!;
    return NextResponse.redirect(
      new URL(`/dashboard/guest-experience/all?conversation=${cid}`, url.origin),
      308,
    );
  }

  const m = path.match(/^\/inbox\/conversations\/([^/]+)$/);
  if (m)
    return NextResponse.redirect(
      new URL(`/dashboard/guest-experience/all?conversation=${m[1]}`, url.origin),
      308,
    );

  return NextResponse.next();
}

export const config = { matcher: ['/((?!_next|static|images|favicon.ico).*)'] };
