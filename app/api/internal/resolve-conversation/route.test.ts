import { test, expect } from '@playwright/test';
import { signResolve } from '../../../../apps/shared/lib/resolveSign.js';
import { prisma } from '../../../../lib/db.js';

const uuid = '123e4567-e89b-12d3-a456-426614174000';

function makeUrl(id: string, ts: number, nonce: string, sig: string) {
  return `https://example.com/api/internal/resolve-conversation?id=${id}&ts=${ts}&nonce=${nonce}&sig=${sig}`;
}

test('valid signature + known legacyId -> 200 { uuid }', async () => {
  process.env.RESOLVE_SECRET = 'secret';
  const { GET } = await import('./route');
  const ts = Date.now();
  const nonce = 'abc';
  const id = '123';
  const sig = signResolve(id, ts, nonce, 'secret');
  prisma.conversation.findFirst = async () => ({ uuid });
  const res = await GET(new Request(makeUrl(id, ts, nonce, sig)));
  expect(res.status).toBe(200);
  await expect(res.json()).resolves.toEqual({ uuid });
});

test('invalid signature -> 401', async () => {
  process.env.RESOLVE_SECRET = 'secret';
  const { GET } = await import('./route');
  const ts = Date.now();
  const nonce = 'abc';
  const id = '123';
  const valid = signResolve(id, ts, nonce, 'secret');
  const sig = valid.replace(/.$/, valid[valid.length - 1] === '0' ? '1' : '0');
  const res = await GET(new Request(makeUrl(id, ts, nonce, sig)));
  expect(res.status).toBe(401);
});

test('stale ts -> 400', async () => {
  process.env.RESOLVE_SECRET = 'secret';
  const { GET } = await import('./route');
  const ts = Date.now() - 5 * 60 * 1000;
  const nonce = 'abc';
  const id = '123';
  const sig = signResolve(id, ts, nonce, 'secret');
  const res = await GET(new Request(makeUrl(id, ts, nonce, sig)));
  expect(res.status).toBe(400);
});

test('not found -> 404', async () => {
  process.env.RESOLVE_SECRET = 'secret';
  const { GET } = await import('./route');
  const ts = Date.now();
  const nonce = 'abc';
  const id = '123';
  const sig = signResolve(id, ts, nonce, 'secret');
  prisma.conversation.findFirst = async () => null;
  const res = await GET(new Request(makeUrl(id, ts, nonce, sig)));
  expect(res.status).toBe(404);
});
