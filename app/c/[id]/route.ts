import { NextResponse } from 'next/server.js';
import { prisma } from '../../../lib/db';
import { conversationDeepLinkFromUuid, appUrlFromRequest } from '../../../apps/shared/lib/links';
// Use robust JS resolver (supports legacyId/slug/redirect probe)
import { tryResolveConversationUuid } from '../../../apps/server/lib/conversations.js';

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const raw = params.id;
  const uuid = await tryResolveConversationUuid(raw);
  const base = appUrlFromRequest(req);
  const to = uuid
    ? conversationDeepLinkFromUuid(uuid, { baseUrl: base })
    : `${base}/dashboard/guest-experience/cs?conversation=${encodeURIComponent(raw)}`;
  return NextResponse.redirect(to, 302);
}
