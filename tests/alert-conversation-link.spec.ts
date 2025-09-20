import { test, expect } from '@playwright/test';
import { ensureAlertConversationLink } from '../lib/alertConversation.js';
import { mintUuidFromRaw } from '../apps/shared/lib/canonicalConversationUuid.js';

const BASE = 'https://app.example.com';
const ORIGINAL_APP_URL = process.env.APP_URL;

function restoreEnv() {
  if (ORIGINAL_APP_URL !== undefined) {
    process.env.APP_URL = ORIGINAL_APP_URL;
  } else {
    delete process.env.APP_URL;
  }
}

test.afterEach(() => {
  restoreEnv();
});

test('ensureAlertConversationLink mints uuid for numeric identifier when resolvers fail', async () => {
  process.env.APP_URL = BASE;
  const calls: string[] = [];
  const link = await ensureAlertConversationLink(
    { primary: 456 },
    {
      baseUrl: BASE,
      strictUuid: true,
      verify: async () => true,
      resolveUuid: async (raw) => {
        calls.push(raw);
        return null;
      },
    },
  );
  expect(calls).toEqual(['456']);
  const expected = mintUuidFromRaw('456');
  expect(link?.uuid).toBe(expected);
  expect(link?.kind).toBe('resolver');
  expect(link?.url).toBe(`${BASE}/r/legacy/456`);
});

test('ensureAlertConversationLink extracts slug from inline thread and mints when needed', async () => {
  process.env.APP_URL = BASE;
  const inlineThread = {
    messages: [
      { conversation_slug: 'inline-slug' },
      { body: 'see https://app.example.com/dashboard/guest-experience/all?conversation=ignored' },
    ],
  };
  const link = await ensureAlertConversationLink(
    { primary: null, inlineThread },
    {
      baseUrl: BASE,
      strictUuid: true,
      verify: async () => true,
      resolveUuid: async () => null,
    },
  );
  const expected = mintUuidFromRaw('inline-slug');
  expect(link?.uuid).toBe(expected);
  expect(link?.kind).toBe('resolver');
  expect(link?.url).toBe(`${BASE}/r/conversation/inline-slug`);
});

test('ensureAlertConversationLink prefers resolver-supplied uuid', async () => {
  process.env.APP_URL = BASE;
  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  const verifyCalls: string[] = [];
  const link = await ensureAlertConversationLink(
    { primary: 'resolver-slug' },
    {
      baseUrl: BASE,
      strictUuid: true,
      resolveUuid: async () => uuid,
      verify: async (url) => {
        verifyCalls.push(url);
        return true;
      },
    },
  );
  expect(link?.uuid).toBe(uuid);
  expect(link?.kind).toBe('uuid');
  expect(link?.url).toBe(`${BASE}/dashboard/guest-experience/all?conversation=${encodeURIComponent(uuid)}`);
  expect(verifyCalls.length).toBeGreaterThan(0);
});
