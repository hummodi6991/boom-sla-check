import { test, expect } from '@playwright/test';
import { ensureAlertConversationLink } from '../lib/alertConversation.js';
import { mintUuidFromRaw } from '../apps/shared/lib/canonicalConversationUuid.js';
import { setTestKeyEnv } from './helpers/testKeys';

const BASE = 'https://app.example.com';
const ORIGINAL_APP_URL = process.env.APP_URL;
const ORIGINAL_PRIVATE_KEY = process.env.LINK_PRIVATE_KEY_PEM;
const ORIGINAL_PUBLIC_KEY = process.env.LINK_PUBLIC_KEY_PEM;
const ORIGINAL_SIGNING_KID = process.env.LINK_SIGNING_KID;

function restoreEnv() {
  if (ORIGINAL_APP_URL !== undefined) {
    process.env.APP_URL = ORIGINAL_APP_URL;
  } else {
    delete process.env.APP_URL;
  }
  if (ORIGINAL_PRIVATE_KEY !== undefined) {
    process.env.LINK_PRIVATE_KEY_PEM = ORIGINAL_PRIVATE_KEY;
  } else {
    delete process.env.LINK_PRIVATE_KEY_PEM;
  }
  if (ORIGINAL_PUBLIC_KEY !== undefined) {
    process.env.LINK_PUBLIC_KEY_PEM = ORIGINAL_PUBLIC_KEY;
  } else {
    delete process.env.LINK_PUBLIC_KEY_PEM;
  }
  if (ORIGINAL_SIGNING_KID !== undefined) {
    process.env.LINK_SIGNING_KID = ORIGINAL_SIGNING_KID;
  } else {
    delete process.env.LINK_SIGNING_KID;
  }
}

test.afterEach(() => {
  restoreEnv();
});

test.beforeEach(() => {
  setTestKeyEnv();
});

test('ensureAlertConversationLink mints uuid for numeric identifier when resolvers fail', async () => {
  process.env.APP_URL = BASE;
  const calls: string[] = [];
  const legacyId = 456;
  const link = await ensureAlertConversationLink(
    { primary: legacyId },
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
  expect(calls).toEqual([String(legacyId)]);
  const expected = mintUuidFromRaw(String(legacyId));
  expect(link?.uuid).toBe(expected);
  expect(link?.kind).toBe('resolver');
  expect(link?.minted).toBe(true);
  expect(link?.url).toBe(
    `${BASE}/r/legacy/${encodeURIComponent(String(legacyId))}`
  );
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
  expect(link?.minted).toBe(true);
  expect(link?.url).toBe(
    `${BASE}/r/conversation/${encodeURIComponent('inline-slug')}`
  );
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
  expect(link?.kind).toBe('token');
  expect(link?.url).toContain('/r/t/');
  expect(verifyCalls.length).toBeGreaterThan(0);
});
