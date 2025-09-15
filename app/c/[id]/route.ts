import { NextResponse } from 'next/server.js';
import { prisma } from '../../../lib/db';
import { conversationDeepLinkFromUuid, appUrl } from '../../../apps/shared/lib/links';
import { tryResolveConversationUuid } from '../../../apps/server/lib/conversations';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const raw = params.id;
  const uuid = await tryResolveConversationUuid(raw);
  const base = appUrl();
  const to = uuid
    ? conversationDeepLinkFromUuid(uuid)
    : (/^\d+$/.test(raw)
        ? `${base}/r/legacy/${encodeURIComponent(raw)}`
        : `${base}/dashboard/guest-experience/cs?conversation=${encodeURIComponent(raw)}`);
  return NextResponse.redirect(to, 302);
}
