import type { NextRequest } from 'next/server.js';
import { NextResponse } from 'next/server.js';

export function middleware(req: NextRequest) {
  const url = new URL(req.url);

  // Match /inbox?cid=...
  const cid = url.searchParams.get('cid');
  if (url.pathname === '/inbox' && cid) {
    const dest = new URL('/dashboard/guest-experience/cs', url);
    url.searchParams.forEach((v, k) => {
      if (k !== 'cid') dest.searchParams.append(k, v);
    });
    dest.searchParams.set('conversation', cid);
    return NextResponse.redirect(dest, { status: 308 });
  }

  // Match /inbox/conversations/:id
  const inboxMatch = url.pathname.match(/^\/inbox\/conversations\/([^/]+)/);
  if (inboxMatch) {
    const id = inboxMatch[1];
    const dest = new URL('/dashboard/guest-experience/cs', url);
    url.searchParams.forEach((v, k) => dest.searchParams.append(k, v));
    dest.searchParams.set('conversation', id);
    return NextResponse.redirect(dest, { status: 308 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/inbox/conversations/:path*', '/inbox'],
};
