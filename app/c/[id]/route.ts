import { NextResponse, NextRequest } from 'next/server';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function resolveLegacyToUuid(legacyId: number): Promise<string | null> {
  const base  = process.env.BOOM_API_BASE;
  const token = process.env.BOOM_API_TOKEN;
  const org   = process.env.BOOM_ORG_ID;

  if (!base || !token || !org) return null;

  const res = await fetch(`${base}/orgs/${org}/conversations/${legacyId}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return null;

  const j = await res.json().catch(() => null) as any;
  const uuid = j?.uuid || j?.id;
  return typeof uuid === 'string' && UUID_RE.test(uuid) ? uuid : null;
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;

  // If already a UUID, deep-link straight to dashboard
  if (UUID_RE.test(id)) {
    const to = new URL('/dashboard/guest-experience/all', req.url);
    to.searchParams.set('conversation', id);
    return NextResponse.redirect(to, 308);
  }

  // If numeric legacy ID, try to resolve to UUID
  const legacy = Number(id);
  if (Number.isFinite(legacy)) {
    const uuid = await resolveLegacyToUuid(legacy);
    if (uuid) {
      const to = new URL('/dashboard/guest-experience/all', req.url);
      to.searchParams.set('conversation', uuid);
      return NextResponse.redirect(to, 308);
    }
  }

  // Fallback: land on dashboard with a notice
  const fallback = new URL('/dashboard/guest-experience/all', req.url);
  fallback.searchParams.set('notice', 'conversation_not_found');
  return NextResponse.redirect(fallback, 307);
}
