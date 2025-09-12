import { NextResponse } from 'next/server.js';

// TODO: replace with your real DB access
import { prisma } from '../../../../lib/db';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const { id } = params;

  let uuid = UUID_RE.test(id) ? id : undefined;

  if (!uuid) {
    if (!Number.isNaN(Number(id))) {
      const conv = await prisma.conversation.findFirst({
        where: { legacyId: Number(id) },
        select: { uuid: true },
      });
      uuid = conv?.uuid;
    } else {
      const conv = await prisma.conversation.findFirst({
        where: { OR: [{ externalId: id }, { publicId: id }, { slug: id }] },
        select: { uuid: true },
      });
      uuid = conv?.uuid;
    }
  }

  const to = new URL('/dashboard/guest-experience/all', req.url);
  if (uuid) to.searchParams.set('conversation', uuid);
  return NextResponse.redirect(to, 308);
}
