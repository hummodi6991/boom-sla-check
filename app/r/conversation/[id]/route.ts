import { NextResponse } from 'next/server.js';
import { ensureConversationUuid } from '../../../../apps/server/lib/conversations';
import { conversationDeepLinkFromUuid, appUrl } from '../../../../apps/shared/lib/links';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const uuid = await ensureConversationUuid(params.id).catch(() => null);
  const to = uuid
    ? conversationDeepLinkFromUuid(uuid)
    : `${appUrl()}/dashboard/guest-experience/cs`;
  return NextResponse.redirect(to, 302);
}
