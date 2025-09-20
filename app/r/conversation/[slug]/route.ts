import { redirect, permanentRedirect } from 'next/navigation.js';
import {
  conversationDeepLink,
  resolveConversationUuid,
} from '../../../../src/lib/conversation/resolve';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request, { params }: { params: { slug: string } }) {
  const origin = new URL(req.url).origin;
  const resolved = await resolveConversationUuid(params.slug, {
    allowMintFallback: true,
    skipRedirectProbe: true,
  });

  if (resolved?.uuid) {
    permanentRedirect(conversationDeepLink(resolved.uuid, origin));
  }

  redirect('/dashboard/guest-experience/all?m=not-found');
}
