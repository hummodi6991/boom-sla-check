import { prisma } from '../../../lib/db.js';

export async function ensureConversationUuid(idOrUuid) {
  const id = String(idOrUuid);
  if (/^[0-9a-f-]{36}$/i.test(id)) {
    const hit = await prisma.conversation.findFirst({ where: { uuid: id.toLowerCase() }, select: { uuid: true }});
    if (hit?.uuid) return hit.uuid;
  }
  if (/^\d+$/.test(id)) {
    const hit = await prisma.conversation.findFirst({ where: { legacyId: Number(id) }, select: { uuid: true }});
    if (hit?.uuid) return hit.uuid;
  }
  const bySlug = await prisma.conversation.findFirst({ where: { slug: id }, select: { uuid: true }});
  if (bySlug?.uuid) return bySlug.uuid;
  throw new Error(`ensureConversationUuid: cannot resolve UUID for ${id}`);
}
