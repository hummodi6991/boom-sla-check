import { NextResponse } from 'next/server.js';
import { prisma } from '../../../lib/db';
import { conversationDeepLink } from '../../../lib/links';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const id = params.id;
  const convo = await prisma.conversation
    .findFirst({
      where: {
        OR: [
          { uuid: id },
          { legacyId: /^\d+$/.test(id) ? Number(id) : -1 },
          { slug: id },
        ],
      },
      select: { uuid: true },
    })
    .catch(() => null);
  const url = conversationDeepLink(convo?.uuid);
  return NextResponse.redirect(url, 302);
}
