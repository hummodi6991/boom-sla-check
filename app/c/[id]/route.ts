import { NextResponse } from 'next/server.js';
import { prisma } from '../../../lib/db';
import { conversationDeepLinkFromUuid, appUrl } from '../../../apps/shared/lib/links';
import { tryResolveConversationUuid } from '../../../apps/server/lib/conversations';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const uuid = await tryResolveConversationUuid(params.id);
  const to = uuid
    ? conversationDeepLinkFromUuid(uuid)
    : `${appUrl()}/dashboard/guest-experience/cs`;
  return NextResponse.redirect(to, 302);
}
