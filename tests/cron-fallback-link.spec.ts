import { test, expect } from '@playwright/test';

test('cron fallback builds shortlinks when UUID is unavailable', async () => {
  process.env.RESOLVE_SECRET = process.env.RESOLVE_SECRET || 'secret';
  (globalThis as any).__CRON_TEST__ = true;
  const mod = await import('../cron.mjs');
  delete (globalThis as any).__CRON_TEST__;
  const { buildSafeDeepLink } = mod as any;
  const a = buildSafeDeepLink('991130', null);
  expect(a).toMatch(/\/go\/c\//);
  const b = buildSafeDeepLink('abc-slug', null);
  expect(b).toMatch(/\/go\/c\//);
});
