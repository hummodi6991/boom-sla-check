import { NextResponse } from 'next/server.js';
import { prisma } from '../../../lib/db';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const { id } = params;

  // UUID → straight to dashboard with query
  if (UUID_RE.test(id)) {
    const to = new URL('/dashboard/guest-experience/all', req.url);
    to.searchParams.set('conversation', id);
    return NextResponse.redirect(to, 302);
  }

  // legacy numeric id
  if (!Number.isNaN(Number(id))) {
    const conv = await prisma.conversation
      .findFirst({
        where: { legacyId: Number(id) },
        select: { uuid: true },
      })
      .catch(() => null);

    if (conv?.uuid) {
      const to = new URL('/dashboard/guest-experience/all', req.url);
      to.searchParams.set('conversation', conv.uuid);
      return NextResponse.redirect(to, 302);
    }
  }

  // NEW: slug / external / public id
  const conv = await prisma.conversation
    .findFirst({
      where: {
        OR: [{ externalId: id }, { publicId: id }, { slug: id }],
      } as any,
      select: { uuid: true },
    })
    .catch(() => null);

  if (conv?.uuid) {
    const to = new URL('/dashboard/guest-experience/all', req.url);
    to.searchParams.set('conversation', conv.uuid);
    return NextResponse.redirect(to, 302);
  }

  // Fallback — dashboard without selection
  const to = new URL('/dashboard/guest-experience/all', req.url);
  return NextResponse.redirect(to, 302);
}
