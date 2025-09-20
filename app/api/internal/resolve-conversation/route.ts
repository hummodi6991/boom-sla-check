import { NextResponse } from 'next/server.js';
import { prisma } from '../../../../lib/db';
import { verifyResolveSignature } from '../../../../apps/shared/lib/resolveSign';
import { mintUuidFromRaw } from '../../../../apps/shared/lib/canonicalConversationUuid';

const RESOLVE_SECRET = process.env.RESOLVE_SECRET || '';
const MAX_SKEW_MS = 2 * 60 * 1000; // 2 minutes
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

function normalizeUuid(uuid: string | null | undefined) {
  return uuid && UUID_RE.test(uuid) ? uuid.toLowerCase() : null;
}

async function resolveLegacyId(legacyId: number) {
  try {
    const alias = await prisma.conversation_aliases.findUnique({ where: { legacy_id: legacyId } });
    const fromAlias = normalizeUuid(alias?.uuid);
    if (fromAlias) {
      const slug = typeof alias?.slug === 'string' ? alias.slug : undefined;
      await prisma.conversation_aliases
        .upsert({
          where: { legacy_id: legacyId },
          create: { legacy_id: legacyId, uuid: fromAlias, ...(slug !== undefined ? { slug } : {}) },
          update: { uuid: fromAlias, ...(slug !== undefined ? { slug } : {}), last_seen_at: new Date() },
        })
        .catch(() => {});
      return fromAlias;
    }
  } catch {}

  try {
    const row = await prisma.conversation.findFirst({ where: { legacyId } });
    const uuid = normalizeUuid(row?.uuid);
    if (uuid) {
      const slug = typeof row?.slug === 'string' ? row.slug : undefined;
      await prisma.conversation_aliases.upsert({
        where: { legacy_id: legacyId },
        create: { legacy_id: legacyId, uuid, ...(slug !== undefined ? { slug } : {}) },
        update: { uuid, ...(slug !== undefined ? { slug } : {}), last_seen_at: new Date() },
      }).catch(() => {});
      return uuid;
    }
  } catch {}
  return null;
}

async function resolveSlug(slug: string) {
  try {
    const row = await prisma.conversation.findFirst({ where: { slug } });
    const uuid = normalizeUuid(row?.uuid);
    if (uuid) {
      const legacyId = Number.isInteger(row?.legacyId) ? Number(row?.legacyId) : undefined;
      if (legacyId !== undefined) {
        await prisma.conversation_aliases
          .upsert({
            where: { legacy_id: legacyId },
            create: { legacy_id: legacyId, uuid, slug },
            update: { uuid, slug, last_seen_at: new Date() },
          })
          .catch(() => {});
      }
      return uuid;
    }
  } catch {}
  return null;
}

async function resolveUuid(uuid: string) {
  if (!UUID_RE.test(uuid)) return null;
  try {
    const row = await prisma.conversation.findUnique?.({ where: { uuid: uuid.toLowerCase() } });
    return normalizeUuid(row?.uuid);
  } catch {
    return null;
  }
}

async function resolveAny(id: string) {
  const raw = (id || '').trim();
  if (!raw) return null;

  if (UUID_RE.test(raw)) {
    const hit = await resolveUuid(raw.toLowerCase());
    if (hit) return hit;
  }

  if (/^\d+$/.test(raw)) {
    const legacyId = Number(raw);
    if (Number.isInteger(legacyId)) {
      const fromLegacy = await resolveLegacyId(legacyId);
      if (fromLegacy) return fromLegacy;
    }
  }

  return resolveSlug(raw);
}

export async function GET(req: Request) {
  if (!RESOLVE_SECRET) {
    return NextResponse.json({ error: 'disabled' }, { status: 503 });
  }

  const { searchParams } = new URL(req.url);
  const id = (searchParams.get('id') || '').trim();
  const ts = Number(searchParams.get('ts') || '0');
  const nonce = (searchParams.get('nonce') || '').trim();
  const sig = (searchParams.get('sig') || '').trim();

  if (!id || !ts || !nonce || !sig) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  const now = Date.now();
  if (Math.abs(now - ts) > MAX_SKEW_MS) {
    return NextResponse.json({ error: 'stale' }, { status: 400 });
  }

  if (
    !verifyResolveSignature({
      id,
      ts,
      nonce,
      sig,
      secret: RESOLVE_SECRET,
    })
  ) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const uuid = await resolveAny(id);
  if (!uuid) {
    // If caller passed a UUID and we couldn't find it, do NOT mint – it's not real.
    if (UUID_RE.test(id)) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    const minted = mintUuidFromRaw(id);
    if (!minted) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    if (/^\d+$/.test(id)) {
      const legacyId = Number(id);
      try {
        await prisma.conversation_aliases.upsert({
          where: { legacy_id: legacyId },
          create: { legacy_id: legacyId, uuid: minted },
          update: { uuid: minted, last_seen_at: new Date() },
        });
      } catch {
        // ignore cache errors
      }
    } else {
      try {
        const row = await prisma.conversation.findFirst({ where: { slug: id } });
        const legacyId = Number((row as any)?.legacyId);
        if (Number.isInteger(legacyId)) {
          await prisma.conversation_aliases.upsert({
            where: { legacy_id: legacyId },
            create: { legacy_id: legacyId, uuid: minted, slug: id },
            update: { uuid: minted, slug: id, last_seen_at: new Date() },
          });
        }
      } catch {
        // ignore cache errors
      }
    }

    return NextResponse.json(
      { uuid: minted, minted: true },
      { status: 200, headers: { 'Cache-Control': 'no-store', 'X-Boom-Minted': '1' } }
    );
  }

  return NextResponse.json(
    { uuid, minted: false },
    { status: 200, headers: { 'Cache-Control': 'no-store', 'X-Boom-Minted': '0' } }
  );
}
