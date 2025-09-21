import { NextResponse } from 'next/server.js';
import { prisma } from '../../../lib/db';
import { conversationDeepLinkFromUuid, appUrlFromRequest } from '../../../apps/shared/lib/links';
// Use robust JS resolver (supports legacyId/slug/redirect probe)
import { tryResolveConversationUuid } from '../../../apps/server/lib/conversations.js';

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const raw = params.id;
  const uuid = await tryResolveConversationUuid(raw);
  const base = appUrlFromRequest(req);
  let to: string;
  if (uuid) {
    to = conversationDeepLinkFromUuid(uuid, { baseUrl: base });
  } else if (/^\d+$/.test(raw)) {
    to = `${base}/dashboard/guest-experience/all?legacyId=${encodeURIComponent(raw)}`;
  } else {
    to = `${base}/dashboard/guest-experience/all?conversation=${encodeURIComponent(raw)}`;
  }
  return NextResponse.redirect(to, 302);
}
