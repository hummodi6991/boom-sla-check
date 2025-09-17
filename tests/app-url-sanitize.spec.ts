import { test, expect } from '@playwright/test';

test('APP_URL with CR/LF produces clean, single-line links', async () => {
  const OLD = process.env.APP_URL;
  process.env.APP_URL = 'https://app.boomnow.com\r\n';

  const { appUrl, makeConversationLink } = await import('../apps/shared/lib/links');
  const { buildSafeDeepLink } = await (async () => {
    (globalThis as any).__CRON_TEST__ = true;
    const mod = await import('../cron.mjs');
    delete (globalThis as any).__CRON_TEST__;
    return mod as any;
  })();

  expect(appUrl()).toBe('https://app.boomnow.com');
  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  const deep = makeConversationLink({ uuid });
  expect(deep).toBe('https://app.boomnow.com/dashboard/guest-experience/all?conversation=123e4567-e89b-12d3-a456-426614174000');
  const fallback = buildSafeDeepLink('991130', null);
  expect(fallback).toBe('https://app.boomnow.com/r/legacy/991130');

  if (OLD !== undefined) process.env.APP_URL = OLD; else delete process.env.APP_URL;
});
