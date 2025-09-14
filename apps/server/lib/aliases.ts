import { prisma } from '../../../lib/db';
import { redis } from '../../../lib/redis';
import { metrics } from '../../../lib/metrics';

const KEY = (id: number) => `conv:alias:legacy:${id}`;

export const aliases = {
  async lookupByLegacyId(legacyId: number): Promise<string | null> {
    const cacheKey = KEY(legacyId);
    const cached = typeof redis?.get === 'function' ? await redis.get(cacheKey) : null;
    if (cached) {
      metrics.increment('conv_alias.cache_hit');
      return String(cached);
    }
    const alias = await prisma.conversation_aliases.findUnique({ where: { legacy_id: legacyId } });
    if (alias?.uuid) {
      metrics.increment('conv_alias.db_hit');
      if (redis) await redis.set(cacheKey, alias.uuid);
      return alias.uuid;
    }
    metrics.increment('conv_alias.not_found');
    return null;
  },
  async upsert({ legacyId, uuid, slug }: { legacyId: number; uuid: string; slug?: string }) {
    await prisma.conversation_aliases.upsert({
      where: { legacy_id: legacyId },
      create: { legacy_id: legacyId, uuid, slug },
      update: { uuid, slug, last_seen_at: new Date() },
    });
    if (redis) await redis.set(KEY(legacyId), uuid);
  },
};
