import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';

// TODO: replace with your real DB access
import { prisma } from '../../../lib/db'; // or whatever you use

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;

  // If it's already a UUID → redirect directly
  if (UUID_RE.test(id)) {
    const to = new URL('/dashboard/guest-experience/all', req.url);
    to.searchParams.set('conversation', id);
    return NextResponse.redirect(to, 308);
  }

  // If it's numeric → look up the UUID, then redirect
  const legacy = Number(id);
  if (Number.isFinite(legacy)) {
    // Adjust to your schema: legacy numeric id -> uuid
    const conv = await prisma.conversation.findUnique({
      where: { legacyId: legacy },
      select: { uuid: true },
    });
    if (conv?.uuid) {
      const to = new URL('/dashboard/guest-experience/all', req.url);
      to.searchParams.set('conversation', conv.uuid);
      return NextResponse.redirect(to, 308);
    }
  }

  // Fallback: land on dashboard without a conversation selected
  const fallback = new URL('/dashboard/guest-experience/all', req.url);
  fallback.searchParams.set('notice', 'conversation_not_found');
  return NextResponse.redirect(fallback, 307);
}
