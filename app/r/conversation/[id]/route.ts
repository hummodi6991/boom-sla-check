import { NextResponse } from 'next/server.js';
// Use robust JS resolver (supports legacyId/slug/redirect probe)
import { tryResolveConversationUuid } from '../../../../apps/server/lib/conversations.js';
import { conversationDeepLinkFromUuid, appUrl } from '../../../../apps/shared/lib/links';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const raw = params.id;
  const uuid = await tryResolveConversationUuid(raw, { skipRedirectProbe: true });
  const to = uuid
    ? conversationDeepLinkFromUuid(uuid)
    : `${appUrl()}/dashboard/guest-experience/cs?conversation=${encodeURIComponent(raw)}`;
  return NextResponse.redirect(to, 302);
}
