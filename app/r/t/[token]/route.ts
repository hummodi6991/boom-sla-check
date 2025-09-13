import { NextResponse } from 'next/server.js';
import { verifyLinkToken } from '../../../../apps/shared/lib/linkToken';
import { conversationDeepLinkFromUuid } from '../../../../apps/shared/lib/links';
import { metrics } from '../../../../lib/metrics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(_req: Request, { params }: { params: { token: string } }) {
  const res = verifyLinkToken(params.token);
  if ('error' in res) {
    metrics.increment(`link_token.${res.error}`);
    return new NextResponse('invalid token', { status: 400 });
  }
  const url = conversationDeepLinkFromUuid(res.uuid);
  return NextResponse.redirect(url, 302);
}
