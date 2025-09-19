import { test, expect } from '@playwright/test';
import { signResolve } from '../../../../apps/shared/lib/resolveSign.js';
import { prisma } from '../../../../lib/db.js';

const uuid = '123e4567-e89b-12d3-a456-426614174000';
const originalFindFirst = prisma.conversation.findFirst;
const originalFindUnique = prisma.conversation.findUnique;
const conversations = prisma.conversation._data as Map<number, any>;
const aliases = prisma.conversation_aliases._data as Map<number, any>;

test.beforeEach(() => {
  process.env.RESOLVE_SECRET = 'secret';
  conversations.clear();
  aliases.clear();
  prisma.conversation.findFirst = originalFindFirst;
  prisma.conversation.findUnique = originalFindUnique;
});

test.afterEach(() => {
  delete process.env.RESOLVE_SECRET;
});

function makeUrl(id: string, ts: number, nonce: string, sig: string) {
  return `https://example.com/api/internal/resolve-conversation?id=${id}&ts=${ts}&nonce=${nonce}&sig=${sig}`;
}

test('valid signature + known legacyId -> 200 { uuid }', async () => {
  const { GET } = await import('./route');
  const ts = Date.now();
  const nonce = 'abc';
  const id = '123';
  const sig = signResolve(id, ts, nonce, process.env.RESOLVE_SECRET!);
  conversations.set(123, { uuid, legacyId: 123 });
  const res = await GET(new Request(makeUrl(id, ts, nonce, sig)));
  expect(res.status).toBe(200);
  await expect(res.json()).resolves.toEqual({ uuid });
});

test('invalid signature -> 401', async () => {
  const { GET } = await import('./route');
  const ts = Date.now();
  const nonce = 'abc';
  const id = '123';
  const valid = signResolve(id, ts, nonce, process.env.RESOLVE_SECRET!);
  const sig = valid.replace(/.$/, valid[valid.length - 1] === '0' ? '1' : '0');
  const res = await GET(new Request(makeUrl(id, ts, nonce, sig)));
  expect(res.status).toBe(401);
});

test('stale ts -> 400', async () => {
  const { GET } = await import('./route');
  const ts = Date.now() - 5 * 60 * 1000;
  const nonce = 'abc';
  const id = '123';
  const sig = signResolve(id, ts, nonce, process.env.RESOLVE_SECRET!);
  const res = await GET(new Request(makeUrl(id, ts, nonce, sig)));
  expect(res.status).toBe(400);
});

test('not found -> deterministic minted uuid (200)', async () => {
  const { GET } = await import('./route');
  const ts = Date.now();
  const nonce = 'abc';
  const id = '123';
  const sig = signResolve(id, ts, nonce, process.env.RESOLVE_SECRET!);
  const res = await GET(new Request(makeUrl(id, ts, nonce, sig)));
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(typeof json.uuid).toBe('string');
  expect(json.uuid).toMatch(/^[0-9a-f-]{36}$/i);
});

test('resolves via alias when legacy conversation missing', async () => {
  const { GET } = await import('./route');
  const ts = Date.now();
  const nonce = 'def';
  const id = '555';
  await prisma.conversation_aliases.upsert({
    where: { legacy_id: 555 },
    create: { legacy_id: 555, uuid },
    update: { uuid },
  });
  const sig = signResolve(id, ts, nonce, process.env.RESOLVE_SECRET!);
  const res = await GET(new Request(makeUrl(id, ts, nonce, sig)));
  expect(res.status).toBe(200);
  await expect(res.json()).resolves.toEqual({ uuid });
});

test('alias lookup bumps last_seen_at timestamp', async () => {
  const { GET } = await import('./route');
  const ts = Date.now();
  const nonce = 'bump';
  const id = '556';
  const legacyId = 556;
  const old = new Date('2020-01-01T00:00:00Z');
  aliases.set(legacyId, { legacy_id: legacyId, uuid, last_seen_at: old });
  const sig = signResolve(id, ts, nonce, process.env.RESOLVE_SECRET!);
  const res = await GET(new Request(makeUrl(id, ts, nonce, sig)));
  expect(res.status).toBe(200);
  const alias = await prisma.conversation_aliases.findUnique({ where: { legacy_id: legacyId } });
  expect(alias?.uuid).toBe(uuid);
  expect(alias?.last_seen_at).toBeInstanceOf(Date);
  expect(alias?.last_seen_at?.getTime()).toBeGreaterThan(old.getTime());
});

test('resolves slug and caches alias', async () => {
  const { GET } = await import('./route');
  const ts = Date.now();
  const nonce = 'ghi';
  const slug = 'chat-99';
  conversations.set(99, { uuid, legacyId: 99, slug });
  const sig = signResolve(slug, ts, nonce, process.env.RESOLVE_SECRET!);
  const res = await GET(new Request(makeUrl(slug, ts, nonce, sig)));
  expect(res.status).toBe(200);
  await expect(res.json()).resolves.toEqual({ uuid });
  const alias = await prisma.conversation_aliases.findUnique({ where: { legacy_id: 99 } });
  expect(alias).toMatchObject({ uuid, slug });
});

test('resolves uuid directly when conversation exists', async () => {
  const { GET } = await import('./route');
  const ts = Date.now();
  const nonce = 'jkl';
  conversations.set(77, { uuid, legacyId: 77 });
  const sig = signResolve(uuid, ts, nonce, process.env.RESOLVE_SECRET!);
  const res = await GET(new Request(makeUrl(uuid, ts, nonce, sig)));
  expect(res.status).toBe(200);
  await expect(res.json()).resolves.toEqual({ uuid });
});
