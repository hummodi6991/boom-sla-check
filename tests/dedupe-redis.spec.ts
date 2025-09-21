import { test, expect } from '@playwright/test';

test('dedupe uses Redis when REDIS_URL is configured', async () => {
  const originalUrl = process.env.REDIS_URL;
  const originalCtor = (globalThis as any).__TEST_IOREDIS__;

  const calls: Array<{ method: string; args: unknown[] }> = [];

  class FakeRedis {
    static instances: FakeRedis[] = [];
    store = new Map<string, string>();
    constructor(public url: string, public opts: Record<string, unknown>) {
      FakeRedis.instances.push(this);
    }
    async connect() {
      calls.push({ method: 'connect', args: [] });
      return undefined;
    }
    async get(key: string) {
      calls.push({ method: 'get', args: [key] });
      return this.store.get(key) ?? null;
    }
    async set(key: string, value: string, mode: string, cond: string, ttl: number) {
      calls.push({ method: 'set', args: [key, value, mode, cond, ttl] });
      if (cond === 'NX' && this.store.has(key)) return null;
      this.store.set(key, value);
      return 'OK';
    }
  }

  (globalThis as any).__TEST_IOREDIS__ = FakeRedis as any;
  process.env.REDIS_URL = 'redis://unit-test';

  const mod = await import(`../lib/dedupe.mjs?${Date.now()}`);
  const { __getImplementationKind, isDuplicateAlert, markAlerted, dedupeKey } = mod;

  expect(__getImplementationKind()).toBe('redis');

  const key = dedupeKey('conv-123', 1700);
  expect(key).toBe('conv-123:1700');

  const first = await isDuplicateAlert('conv-123', 1700);
  expect(first.dup).toBe(false);
  expect(calls.find((c) => c.method === 'get')?.args[0]).toBe('conv-123:1700');

  await markAlerted(first.state, 'conv-123', 1700);
  const second = await isDuplicateAlert('conv-123', 1700);
  expect(second.dup).toBe(true);

  expect(FakeRedis.instances).toHaveLength(1);
  expect(FakeRedis.instances[0].opts?.lazyConnect).toBe(true);

  if (originalUrl !== undefined) {
    process.env.REDIS_URL = originalUrl;
  } else {
    delete process.env.REDIS_URL;
  }
  if (originalCtor !== undefined) {
    (globalThis as any).__TEST_IOREDIS__ = originalCtor;
  } else {
    delete (globalThis as any).__TEST_IOREDIS__;
  }
});
