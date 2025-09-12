import type { NextRequest } from 'next/server.js';
import { NextResponse } from 'next/server.js';

export function middleware(req: NextRequest) {
  const url = new URL(req.url);

  // Match /r/conversation/:id
  const match = url.pathname.match(/^\/r\/conversation\/([^/]+)/);
  if (match) {
    const id = match[1];
    const dest = new URL('/dashboard/guest-experience/all', url);

    // Preserve incoming params; override/add conversation
    url.searchParams.forEach((v, k) => dest.searchParams.append(k, v));
    dest.searchParams.set('conversation', id);

    return NextResponse.redirect(dest, { status: 302 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/r/conversation/:path*'],
};
