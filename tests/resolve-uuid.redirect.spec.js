import { test, expect } from '@playwright/test';
import { tryResolveConversationUuid } from '../apps/server/lib/conversations.js';

process.env.APP_URL = 'https://app.boomnow.com';

// Monkeypatch global fetch for the test
const OLD_FETCH = global.fetch;

test.beforeEach(() => {
  global.fetch = async (_url, _opts) => ({
    headers: new Map([[
      'location',
      'https://app.boomnow.com/dashboard/guest-experience/cs?conversation=123e4567-e89b-12d3-a456-426614174000'
    ]]),
  });
});

test.afterEach(() => {
  global.fetch = OLD_FETCH;
});

test('resolves via redirect probe from legacy numeric id', async () => {
  const got = await tryResolveConversationUuid('991130', {});
  expect(got).toBe('123e4567-e89b-12d3-a456-426614174000');
});
