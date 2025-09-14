import { test, expect } from '@playwright/test';

const uuid = '123e4567-e89b-12d3-a456-426614174000';

test('cron uses internal endpoint resolver', async () => {
  process.env.RESOLVE_SECRET = 'secret';
  process.env.RESOLVE_BASE_URL = 'https://app.boomnow.com';
  let called = false;
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    called = true;
    return { ok: true, json: async () => ({ uuid }) } as any;
  };
  (globalThis as any).__CRON_TEST__ = true;
  const { resolveViaInternalEndpoint } = await import('../cron.mjs');
  delete (globalThis as any).__CRON_TEST__;
  const got = await resolveViaInternalEndpoint('991130');
  expect(called).toBe(true);
  expect(got).toBe(uuid);
  global.fetch = originalFetch;
});
