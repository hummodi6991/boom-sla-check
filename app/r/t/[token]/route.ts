import { redirect } from 'next/navigation.js';
import { verifyLinkToken } from '../../../../src/lib/links/tokens';
import { conversationDeepLink } from '../../../../src/lib/conversation/resolve';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request, { params }: { params: { token: string } }) {
  const origin = new URL(req.url).origin;
  try {
    const { payload } = await verifyLinkToken(params.token);
    const uuid = String(payload?.conversation || '');
    if (!uuid) throw new Error('missing conversation');
    redirect(conversationDeepLink(uuid, origin));
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'digest' in err &&
      typeof (err as any).digest === 'string' &&
      (err as any).digest.startsWith('NEXT_REDIRECT')
    ) {
      throw err;
    }
    const url = new URL(req.url);
    const backup = url.searchParams.get('conversation');
    if (backup) {
      redirect(conversationDeepLink(backup, origin));
    }
    redirect('/dashboard/guest-experience/all?m=link-expired');
  }
}
