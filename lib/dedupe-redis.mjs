import IORedis from 'ioredis';

const RedisCtor = globalThis.__TEST_IOREDIS__ || IORedis;
const url = process.env.REDIS_URL || '';
let r = url ? new RedisCtor(url, { lazyConnect: true }) : null;

export const __kind = 'redis';

export function dedupeKey(convId, lastTs) {
  return `${convId}:${lastTs ?? ''}`;
}

export async function isDuplicateAlert(convId, lastTs) {
  const key = dedupeKey(convId, lastTs);
  if (!r) return { dup: false, state: {} };
  await r.connect?.().catch(() => {});
  const v = await r.get(key);
  return { dup: Boolean(v), state: {} };
}

export async function markAlerted(_state, convId, lastTs) {
  const key = dedupeKey(convId, lastTs);
  if (!r) return; // fallback handled by file-based path
  const ttl = Number(process.env.ALERT_DEDUPE_TTL_SECONDS || 14 * 24 * 3600);
  await r.set(key, '1', 'NX', 'EX', ttl);
}

export const __test__ = {
  get client() {
    return r;
  },
};
