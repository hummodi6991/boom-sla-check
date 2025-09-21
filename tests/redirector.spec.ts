import { test, expect } from '@playwright/test';
import { createRedirectorApp } from '../apps/redirector/app.js';
import { signLink } from '../packages/linking/src/jwt.js';
import { buildCanonicalDeepLink } from '../packages/linking/src/deeplink.js';
import { prisma } from '../lib/db.js';
import { setTestKeyEnv, TEST_PRIVATE_JWK } from './helpers/testKeys';

const CONV_MAP = prisma.conversation._data;

const ORIGINAL_TARGET = process.env.TARGET_APP_URL;

test.beforeEach(() => {
  setTestKeyEnv();
  process.env.TARGET_APP_URL = 'https://app.example.com';
  CONV_MAP.clear();
});

test.afterEach(() => {
  if (ORIGINAL_TARGET !== undefined) {
    process.env.TARGET_APP_URL = ORIGINAL_TARGET;
  } else {
    delete process.env.TARGET_APP_URL;
  }
});

const UUID = '01890b14-b4cd-7eef-b13e-bb8c083bad60';
const LEGACY_ID = 1010993;

function tokenPayload() {
  return {
    t: 'conversation',
    uuid: UUID,
    legacyId: LEGACY_ID,
  };
}

async function signTestToken(opts = {}) {
  return signLink(tokenPayload(), {
    privateJwk: TEST_PRIVATE_JWK,
    kid: 'test-key',
    iss: 'sla-check',
    aud: 'boom-app',
    ttlSeconds: 300,
    ...opts,
  });
}

test('HEAD /u/:token returns 303 with Location header', async () => {
  CONV_MAP.set(LEGACY_ID, { legacyId: LEGACY_ID, uuid: UUID });
  const app = createRedirectorApp();
  const token = await signTestToken();
  const res = await app.fetch(new Request(`http://redirect.example/u/${token}`, { method: 'HEAD' }));
  expect(res.status).toBe(303);
  const location = res.headers.get('location');
  expect(location).toBe(
    buildCanonicalDeepLink({ appUrl: 'https://app.example.com', uuid: UUID })
  );
});

test('GET /u/:token with expired JWT redirects to legacy fallback', async () => {
  const app = createRedirectorApp();
  const token = await signTestToken({ ttlSeconds: 60, now: Date.now() - 86400000 });
  const res = await app.fetch(new Request(`http://redirect.example/u/${token}`, { method: 'GET' }));
  expect(res.status).toBe(303);
  expect(res.headers.get('location')).toBe(
    'https://app.example.com/dashboard/guest-experience/cs?legacyId=1010993'
  );
});

test('GET /c/:legacyId resolves to canonical deep link', async () => {
  CONV_MAP.set(LEGACY_ID, { legacyId: LEGACY_ID, uuid: UUID });
  const app = createRedirectorApp();
  const res = await app.fetch(new Request('http://redirect.example/c/1010993', { method: 'GET' }));
  expect(res.status).toBe(303);
  expect(res.headers.get('location')).toBe(
    buildCanonicalDeepLink({ appUrl: 'https://app.example.com', uuid: UUID })
  );
});

test('double-encoded /c path still resolves to canonical location', async () => {
  CONV_MAP.set(LEGACY_ID, { legacyId: LEGACY_ID, uuid: UUID });
  const canonical = buildCanonicalDeepLink({ appUrl: 'https://app.example.com', uuid: UUID });
  const wrapped = encodeURIComponent(encodeURIComponent(canonical));
  const app = createRedirectorApp();
  const res = await app.fetch(
    new Request(`http://redirect.example/c/${wrapped}`, { method: 'GET' }),
  );
  expect(res.status).toBe(303);
  expect(res.headers.get('location')).toBe(canonical);
});
