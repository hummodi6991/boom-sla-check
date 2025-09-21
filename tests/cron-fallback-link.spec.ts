import { test, expect } from '@playwright/test';
import { mintUuidFromRaw } from '../apps/shared/lib/canonicalConversationUuid.js';

test('cron fallback builds shortlinks when UUID is unavailable', async () => {
  process.env.RESOLVE_SECRET = process.env.RESOLVE_SECRET || 'secret';
  (globalThis as any).__CRON_TEST__ = true;
  const mod = await import('../cron.mjs');
  delete (globalThis as any).__CRON_TEST__;
  const { buildSafeDeepLink } = mod as any;
  const a = buildSafeDeepLink('991130', null);
  const mintedNumeric = mintUuidFromRaw('991130');
  expect(a).toBe(
    `https://app.boomnow.com/dashboard/guest-experience/all?conversation=${encodeURIComponent(mintedNumeric)}`
  );
  const numericParam = new URL(a).searchParams.get('conversation');
  expect(numericParam).toBe(mintedNumeric);
  expect(numericParam && /^\d+$/.test(numericParam)).toBe(false);

  const b = buildSafeDeepLink('abc-slug', null);
  const mintedSlug = mintUuidFromRaw('abc-slug');
  expect(b).toBe(
    `https://app.boomnow.com/dashboard/guest-experience/all?conversation=${encodeURIComponent(mintedSlug)}`
  );
  const slugParam = new URL(b).searchParams.get('conversation');
  expect(slugParam).toBe(mintedSlug);
});
