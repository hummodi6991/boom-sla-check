import { prisma } from '../../../lib/db';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const dash = (v?: string) => {
    const u = new URL('/dashboard/guest-experience/cs', req.url);
    if (v) u.searchParams.set('conversation', v);
    return u;
  };

  const id = params.id;
  if (UUID_RE.test(id)) return Response.redirect(dash(id), 302);

  if (!Number.isNaN(Number(id))) {
    const conv = await prisma.conversation
      .findFirst({
        where: { legacyId: Number(id) },
        select: { uuid: true },
      })
      .catch(() => null);
    if (conv?.uuid) return Response.redirect(dash(conv.uuid), 302);
  }

  const conv = await prisma.conversation
    .findFirst({
      where: { OR: [{ externalId: id }, { publicId: id }, { slug: id }] } as any,
      select: { uuid: true },
    })
    .catch(() => null);

  return Response.redirect(dash(conv?.uuid), 302);
}
