import { prisma } from '../../../../lib/db';
import { redis } from '../../../../lib/redis';
import { metrics } from '../../../../lib/metrics';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

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

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const legacy = searchParams.get('legacyId');
  if (!legacy || !/^\d+$/.test(legacy)) {
    return json({ error: 'bad_request' }, { status: 400 });
  }
  const legacyId = Number(legacy);
  const cacheKey = `conv:alias:legacy:${legacyId}`;
  const cached = typeof redis?.get === 'function' ? await redis.get(cacheKey) : null;
  if (cached && UUID_RE.test(String(cached))) {
    metrics.increment('conv_alias.cache_hit');
    return json({ uuid: String(cached).toLowerCase() }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  }

  const uuid = await dbLookup(legacyId);
  if (uuid) {
    metrics.increment('conv_alias.db_hit');
    if (redis) await redis.set(cacheKey, uuid, { EX: 7 * 24 * 3600 });
    return json({ uuid }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  }

  metrics.increment('conv_alias.not_found');
  return json({ error: 'not_found' }, { status: 404 });
}
