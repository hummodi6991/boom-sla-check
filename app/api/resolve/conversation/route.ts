import { prisma } from '../../../../lib/db';
import { redis } from '../../../../lib/redis';
import { metrics } from '../../../../lib/metrics';
import { resolveConversation } from '../../../../packages/linking/src/index.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CACHE_HEADERS = { 'Cache-Control': 'no-store' };
const CACHE_TTL_SECONDS = 7 * 24 * 3600;

async function dbLookup(legacyId: number) {
  const alias = await prisma.conversation_aliases.findUnique({ where: { legacy_id: legacyId } });
  if (alias?.uuid && UUID_RE.test(alias.uuid)) {
    return alias.uuid.toLowerCase();
  }

  const row = await prisma.conversation.findFirst({ where: { legacyId } });
  const uuid = row?.uuid && UUID_RE.test(row.uuid) ? row.uuid.toLowerCase() : null;
  if (uuid) {
    const slug = typeof row?.slug === 'string' ? row.slug : undefined;
    await prisma.conversation_aliases.upsert({
      where: { legacy_id: legacyId },
      create: { legacy_id: legacyId, uuid, ...(slug !== undefined ? { slug } : {}) },
      update: { uuid, ...(slug !== undefined ? { slug } : {}), last_seen_at: new Date() },
    });
    return uuid;
  }
  return null;
}

function json(body: any, init: ResponseInit) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

function normalize(value: string | null) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

async function legacyUuid(legacyId: number) {
  const cacheKey = `conv:alias:legacy:${legacyId}`;
  const cached = typeof redis?.get === 'function' ? await redis.get(cacheKey) : null;
  if (cached && UUID_RE.test(String(cached))) {
    metrics.increment('conv_alias.cache_hit');
    return String(cached).toLowerCase();
  }

  const uuid = await dbLookup(legacyId);
  if (uuid) {
    metrics.increment('conv_alias.db_hit');
    if (redis) await redis.set(cacheKey, uuid, { EX: CACHE_TTL_SECONDS });
    return uuid;
  }

  metrics.increment('conv_alias.not_found');
  return null;
}

function cacheResolvedLegacy(legacyId: number, uuid: string) {
  if (!redis) return;
  const cacheKey = `conv:alias:legacy:${legacyId}`;
  redis.set(cacheKey, uuid, { EX: CACHE_TTL_SECONDS }).catch(() => {});
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const raw = normalize(searchParams.get('raw'));
  const uuidParam = normalize(searchParams.get('uuid'));
  const legacyParam = normalize(searchParams.get('legacyId'));
  const slugParam = normalize(searchParams.get('slug'));

  let uuidCandidate = uuidParam && UUID_RE.test(uuidParam) ? uuidParam.toLowerCase() : null;
  let legacyCandidate = legacyParam && /^\d+$/.test(legacyParam) ? Number(legacyParam) : null;
  let slugCandidate = slugParam || null;

  if (raw) {
    if (!uuidCandidate && UUID_RE.test(raw)) {
      uuidCandidate = raw.toLowerCase();
    } else if (!legacyCandidate && /^\d+$/.test(raw)) {
      legacyCandidate = Number(raw);
    } else if (!slugCandidate) {
      slugCandidate = raw;
    }
  }

  if (uuidCandidate) {
    try {
      const resolved = await resolveConversation({
        uuid: uuidCandidate,
        skipRedirectProbe: true,
      });
      if (resolved?.uuid) {
        return json({ uuid: resolved.uuid }, { status: 200, headers: CACHE_HEADERS });
      }
    } catch {
      // fall through to return the candidate uuid below
    }
    return json({ uuid: uuidCandidate }, { status: 200, headers: CACHE_HEADERS });
  }

  if (legacyCandidate != null) {
    const resolved = await resolveConversation({
      legacyId: String(legacyCandidate),
      allowMintFallback: false,
      skipRedirectProbe: true,
    }).catch(() => null);
    if (resolved?.uuid && UUID_RE.test(resolved.uuid)) {
      const normalizedUuid = resolved.uuid.toLowerCase();
      let enrichedUuid: string | null = null;
      try {
        enrichedUuid = await dbLookup(legacyCandidate);
      } catch {
        enrichedUuid = null;
      }
      const finalUuid = enrichedUuid && UUID_RE.test(enrichedUuid) ? enrichedUuid : normalizedUuid;
      cacheResolvedLegacy(legacyCandidate, finalUuid);
      if (!enrichedUuid) {
        await prisma.conversation_aliases.upsert({
          where: { legacy_id: legacyCandidate },
          create: { legacy_id: legacyCandidate, uuid: finalUuid },
          update: { uuid: finalUuid, last_seen_at: new Date() },
        });
      }
      return json({ uuid: finalUuid }, { status: 200, headers: CACHE_HEADERS });
    }

    const uuid = await legacyUuid(legacyCandidate);
    if (uuid) {
      return json({ uuid }, { status: 200, headers: CACHE_HEADERS });
    }
    return json({ error: 'not_found' }, { status: 404, headers: CACHE_HEADERS });
  }

  if (slugCandidate) {
    const resolved = await resolveConversation({
      slug: slugCandidate,
      allowMintFallback: true,
      skipRedirectProbe: true,
    }).catch(() => null);
    if (resolved?.uuid && UUID_RE.test(resolved.uuid)) {
      return json({ uuid: resolved.uuid.toLowerCase() }, { status: 200, headers: CACHE_HEADERS });
    }
    return json({ error: 'not_found' }, { status: 404, headers: CACHE_HEADERS });
  }

  return json({ error: 'bad_request' }, { status: 400, headers: CACHE_HEADERS });
}
