import { NextResponse } from 'next/server.js';
import { tryResolveConversationUuid } from '../../../../apps/server/lib/conversations';
import { conversationDeepLinkFromUuid, appUrl } from '../../../../apps/shared/lib/links';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const raw = params.id;
  const uuid = await tryResolveConversationUuid(raw);
  const base = appUrl();
  const to = uuid
    ? conversationDeepLinkFromUuid(uuid)
    : (/^\d+$/.test(raw)
        // Numeric legacy id → let the server resolver map to UUID
        ? `${base}/r/legacy/${encodeURIComponent(raw)}`
        // Non‑numeric slug → open CS with the slug preserved
        : `${base}/dashboard/guest-experience/cs?conversation=${encodeURIComponent(raw)}`);
  return NextResponse.redirect(to, 302);
}
