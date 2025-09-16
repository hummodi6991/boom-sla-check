import type { NextRequest } from 'next/server.js';
import { NextResponse } from 'next/server.js';

function redirectToConversation(url: URL, conversation: string) {
  const dest = new URL(url);
  dest.pathname = '/dashboard/guest-experience/cs';
  dest.searchParams.delete('cid');
  dest.searchParams.set('conversation', conversation);
  return NextResponse.redirect(dest, { status: 308 });
}

export function middleware(req: NextRequest) {
  const url = new URL(req.url);

  // Match /inbox?cid=...
  const cid = url.searchParams.get('cid');
  if (url.pathname === '/inbox' && cid) {
    return redirectToConversation(url, cid);
  }

  // Match /inbox/conversations/:id
  const inboxMatch = url.pathname.match(/^\/inbox\/conversations\/([^/]+)/);
  if (inboxMatch) {
    return redirectToConversation(url, inboxMatch[1]);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/inbox/conversations/:path*', '/inbox'],
};
