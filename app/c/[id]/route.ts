import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';

// TODO: replace with your real DB access
import { prisma } from '../../../lib/db'; // or whatever you use

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;

  // If already a UUID → redirect directly to dashboard with query param
  if (UUID_RE.test(id)) {
    const to = new URL('/dashboard/guest-experience/all', req.url);
    to.searchParams.set('conversation', id);
    return NextResponse.redirect(to, 308);
  }

  // If numeric legacy id → existing lookup flow
  if (!Number.isNaN(Number(id))) {
    const conv = await prisma.conversation.findFirst({
      where: { legacyId: Number(id) },
      select: { uuid: true },
    });
    if (conv?.uuid) {
      const to = new URL('/dashboard/guest-experience/all', req.url);
      to.searchParams.set('conversation', conv.uuid);
      return NextResponse.redirect(to, 308);
    }
  }

  // NEW: handle slugs / external ids / public ids
  const conv = await prisma.conversation.findFirst({
    where: {
      OR: [{ externalId: id }, { publicId: id }, { slug: id }],
    },
    select: { uuid: true },
  });
  if (conv?.uuid) {
    const to = new URL('/dashboard/guest-experience/all', req.url);
    to.searchParams.set('conversation', conv.uuid);
    return NextResponse.redirect(to, 308);
  }

  // Fallback: land on dashboard without a conversation selected
  const to = new URL('/dashboard/guest-experience/all', req.url);
  return NextResponse.redirect(to, 308);
}
