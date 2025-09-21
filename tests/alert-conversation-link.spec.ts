import { test, expect } from '@playwright/test';
import { ensureAlertConversationLink } from '../lib/alertConversation.js';
import { mintUuidFromRaw } from '../apps/shared/lib/canonicalConversationUuid.js';
import { setTestKeyEnv } from './helpers/testKeys';

const BASE = 'https://app.example.com';
const ORIGINAL_APP_URL = process.env.APP_URL;
const ORIGINAL_PRIVATE_JWK = process.env.LINK_PRIVATE_JWK;
const ORIGINAL_PUBLIC_JWKS = process.env.LINK_PUBLIC_JWKS;
const ORIGINAL_SIGNING_KID = process.env.LINK_KID;

function restoreEnv() {
  if (ORIGINAL_APP_URL !== undefined) {
    process.env.APP_URL = ORIGINAL_APP_URL;
  } else {
    delete process.env.APP_URL;
  }
  if (ORIGINAL_PRIVATE_JWK !== undefined) {
    process.env.LINK_PRIVATE_JWK = ORIGINAL_PRIVATE_JWK;
  } else {
    delete process.env.LINK_PRIVATE_JWK;
  }
  if (ORIGINAL_PUBLIC_JWKS !== undefined) {
    process.env.LINK_PUBLIC_JWKS = ORIGINAL_PUBLIC_JWKS;
  } else {
    delete process.env.LINK_PUBLIC_JWKS;
  }
  if (ORIGINAL_SIGNING_KID !== undefined) {
    process.env.LINK_KID = ORIGINAL_SIGNING_KID;
  } else {
    delete process.env.LINK_KID;
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
  expect(link?.kind).toBe('deep-link');
  expect(link?.minted).toBe(true);
  expect(link?.url).toBe(`${BASE}/go/c/${encodeURIComponent(expected)}`);
});

test('ensureAlertConversationLink extracts slug from inline thread and mints when needed', async () => {
  process.env.APP_URL = BASE;
  const inlineThread = {
    messages: [
      { conversation_slug: 'inline-slug' },
      { body: 'see https://app.example.com/go/c/ignored' },
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
  expect(link?.kind).toBe('deep-link');
  expect(link?.minted).toBe(true);
  expect(link?.url).toBe(`${BASE}/go/c/${encodeURIComponent(expected)}`);
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
