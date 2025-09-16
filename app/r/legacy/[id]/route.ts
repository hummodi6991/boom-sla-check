import { NextResponse } from 'next/server.js';
import { tryResolveConversationUuid } from '../../../../apps/server/lib/conversations.js';
import { conversationDeepLinkFromUuid, appUrlFromRequest } from '../../../../apps/shared/lib/links';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const base = appUrlFromRequest(req);
  let uuid: string | null = null;
  try {
    uuid = await tryResolveConversationUuid(params.id, { skipRedirectProbe: true });
  } catch {
    uuid = null;
  }

  const to = uuid ? conversationDeepLinkFromUuid(uuid, { baseUrl: base }) : `${base}/conversation-not-found`;
  return NextResponse.redirect(to, 302);
}
