import { prisma } from '../../../lib/db';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const { id } = params;

  const toDash = (v?: string) => {
    const to = new URL('/dashboard/guest-experience/all', req.url);
    if (v) to.searchParams.set('conversation', v);
    return to;
  };

  if (UUID_RE.test(id)) return Response.redirect(toDash(id), 302);

  if (!Number.isNaN(Number(id))) {
    const conv = await prisma.conversation
      .findFirst({
        where: { legacyId: Number(id) }, // keep if field exists
        select: { uuid: true },
      })
      .catch(() => null);
    if (conv?.uuid) return Response.redirect(toDash(conv.uuid), 302);
  }

  const conv = await prisma.conversation
    .findFirst({
      where: { OR: [{ externalId: id }, { publicId: id }, { slug: id }] } as any,
      select: { uuid: true },
    })
    .catch(() => null);

  return Response.redirect(toDash(conv?.uuid), 302);
}
