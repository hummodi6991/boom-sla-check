import { prisma } from '../../../lib/db.js';

export async function tryResolveConversationUuid(
  idOrUuid,
  opts = {}
) {
  const id = String(idOrUuid ?? '');

  if (/^[0-9a-f-]{36}$/i.test(id)) return id.toLowerCase();

  if (/^\d+$/.test(id)) {
    const hit = await prisma.conversation.findFirst({ where: { legacyId: Number(id) }, select: { uuid: true }});
    if (hit?.uuid) return hit.uuid.toLowerCase();
  }

  const bySlug = await prisma.conversation.findFirst({ where: { slug: id }, select: { uuid: true }});
  if (bySlug?.uuid) return bySlug.uuid.toLowerCase();

  const t = opts?.inlineThread;
  const candidates = [
    t?.conversation?.uuid,
    t?.conversation_uuid,
    t?.messages?.[0]?.conversation_uuid,
    t?.messages?.[0]?.conversation?.uuid,
  ].filter(Boolean);
  const guess = candidates.find(x => /^[0-9a-f-]{36}$/i.test(String(x)));
  if (guess) return String(guess).toLowerCase();

  return null;
}
