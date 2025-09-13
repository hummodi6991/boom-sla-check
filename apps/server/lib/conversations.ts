import { prisma } from '../../../lib/db';

export async function tryResolveConversationUuid(
  idOrUuid: string,
  opts?: { inlineThread?: any }
): Promise<string | null> {
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
  const idCandidates = [
    t?.conversation?.id,
    t?.conversation_id,
    t?.messages?.[0]?.conversation_id,
    t?.messages?.[0]?.conversation?.id,
  ].filter(Boolean);
  const guess = candidates.find((x: string) => /^[0-9a-f-]{36}$/i.test(String(x)));
  if (guess) return String(guess).toLowerCase();

  for (const raw of idCandidates) {
    const v = String(raw);
    if (/^\d+$/.test(v)) {
      const hit = await prisma.conversation.findFirst({ where: { legacyId: Number(v) }, select: { uuid: true }});
      if (hit?.uuid) return hit.uuid.toLowerCase();
    }
    const bySlug = await prisma.conversation.findFirst({ where: { slug: v }, select: { uuid: true }});
    if (bySlug?.uuid) return bySlug.uuid.toLowerCase();
  }

  return null;
}
