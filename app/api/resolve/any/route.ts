import { NextResponse } from 'next/server.js';
import { tryResolveConversationUuid } from '../../../../apps/server/lib/conversations.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const raw = (searchParams.get('id') || '').trim();
  if (!raw) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  try {
    // No minting here; this endpoint is purely for canonical resolution.
    const uuid = await tryResolveConversationUuid(raw, { skipRedirectProbe: false });
    if (uuid) {
      return NextResponse.json(
        { uuid: String(uuid).toLowerCase() },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }
  } catch {}
  return NextResponse.json({ error: 'not_found' }, { status: 404 });
}
