import { test, expect } from '@playwright/test';
import { GET } from '../app/api/resolve/conversation/route';
import { prisma } from '../lib/db';

const uuid = '123e4567-e89b-12d3-a456-426614174000';

test('known alias in DB -> 200 { uuid }', async () => {
  await prisma.conversation_aliases.upsert({
    where: { legacy_id: 123 },
    create: { legacy_id: 123, uuid },
    update: { uuid },
  });
  const res = await GET(new Request('http://test/api/resolve/conversation?legacyId=123'));
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json).toEqual({ uuid });
});

test('not found -> 404', async () => {
  const res = await GET(new Request('http://test/api/resolve/conversation?legacyId=999999'));
  expect(res.status).toBe(404);
});

test('missing or invalid legacyId -> 400', async () => {
  let res = await GET(new Request('http://test/api/resolve/conversation'));
  expect(res.status).toBe(400);
  res = await GET(new Request('http://test/api/resolve/conversation?legacyId=abc'));
  expect(res.status).toBe(400);
});

test('falls back to DB and upserts alias when missing', async () => {
  prisma.conversation._data.set(789, { uuid, legacyId: 789, slug: 'chat-789' } as any);
  const res = await GET(new Request('http://test/api/resolve/conversation?legacyId=789'));
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json).toEqual({ uuid });
  const alias = await prisma.conversation_aliases.findUnique({ where: { legacy_id: 789 } });
  expect(alias).toMatchObject({ uuid, slug: 'chat-789' });
});
