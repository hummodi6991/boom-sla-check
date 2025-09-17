import { NextResponse } from 'next/server.js';
// Use robust JS resolver (supports legacyId/slug/redirect probe)
import { tryResolveConversationUuid } from '../../../../apps/server/lib/conversations.js';
import { conversationDeepLinkFromUuid, appUrlFromRequest } from '../../../../apps/shared/lib/links';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const raw = params.id;
  const uuid = await tryResolveConversationUuid(raw, { skipRedirectProbe: true });
  const base = appUrlFromRequest(req);
  const to = uuid
    ? conversationDeepLinkFromUuid(uuid, { baseUrl: base })
    : `${base}/dashboard/guest-experience/all?conversation=${encodeURIComponent(raw)}`;
  return NextResponse.redirect(to, 302);
}
