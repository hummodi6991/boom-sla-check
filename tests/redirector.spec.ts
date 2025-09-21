import { test, expect } from '@playwright/test';
import { createRedirectorApp } from '../apps/redirector/app.js';
import { signLink } from '../packages/linking/src/jwt.js';
import { prisma } from '../lib/db.js';
import { setTestKeyEnv, TEST_PRIVATE_JWK } from './helpers/testKeys';

const CONV_MAP = prisma.conversation._data;

const ORIGINAL_TARGET = process.env.TARGET_APP_URL;
const ORIGINAL_MESSAGES_URL = process.env.MESSAGES_URL;
const ORIGINAL_FETCH = global.fetch;

let fetchHandler;

test.beforeEach(() => {
  setTestKeyEnv();
  process.env.TARGET_APP_URL = 'https://app.example.com';
  process.env.MESSAGES_URL =
    'https://app.example.com/api/conversations/{{conversationId}}/messages';
  CONV_MAP.clear();
  fetchHandler = async (input, init) => ORIGINAL_FETCH(input, init);
  global.fetch = (input, init) => fetchHandler(input, init);
});

test.afterEach(() => {
  if (ORIGINAL_TARGET !== undefined) {
    process.env.TARGET_APP_URL = ORIGINAL_TARGET;
  } else {
    delete process.env.TARGET_APP_URL;
  }
  if (ORIGINAL_MESSAGES_URL !== undefined) {
    process.env.MESSAGES_URL = ORIGINAL_MESSAGES_URL;
  } else {
    delete process.env.MESSAGES_URL;
  }
  global.fetch = ORIGINAL_FETCH;
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

function mockMessagesResponse({ uuid = UUID, workspace = 'resort-east' } = {}) {
  fetchHandler = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (url) {
      const convoMatch = url.match(/\/api\/conversations\/([^/]+)\/messages/i);
      const geMatch = url.match(
        /\/api\/guest-experience\/messages\?(?:conversation|conversation_id)=([^&]+)/i,
      );
      if (convoMatch || geMatch) {
        const body = {
          conversation: { uuid, workspace_slug: workspace, workspace: { slug: workspace } },
          messages: [
            {
              conversation_uuid: uuid,
              conversation: { uuid, workspace_slug: workspace },
            },
          ],
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return ORIGINAL_FETCH(input, init);
  };
}

test('HEAD /u/:token returns 303 with Location header', async () => {
  CONV_MAP.set(LEGACY_ID, { legacyId: LEGACY_ID, uuid: UUID });
  mockMessagesResponse();
  const app = createRedirectorApp();
  const token = await signTestToken();
  const res = await app.fetch(new Request(`http://redirect.example/u/${token}`, { method: 'HEAD' }));
  expect(res.status).toBe(303);
  const location = res.headers.get('location');
  expect(location).toBe(
    `https://app.example.com/dashboard/guest-experience/all?conversation=${UUID.toLowerCase()}&workspace=resort-east`
  );
});

test('GET /u/:token with expired JWT redirects to legacy fallback', async () => {
  const app = createRedirectorApp();
  const token = await signTestToken({ ttlSeconds: 60, now: Date.now() - 86400000 });
  const res = await app.fetch(new Request(`http://redirect.example/u/${token}`, { method: 'GET' }));
  expect(res.status).toBe(303);
  expect(res.headers.get('location')).toBe(
    'https://app.example.com/go/c/1010993'
  );
});

test('GET /c/:legacyId resolves to canonical deep link', async () => {
  CONV_MAP.set(LEGACY_ID, { legacyId: LEGACY_ID, uuid: UUID });
  mockMessagesResponse();
  const app = createRedirectorApp();
  const res = await app.fetch(new Request('http://redirect.example/c/1010993', { method: 'GET' }));
  expect(res.status).toBe(303);
  expect(res.headers.get('location')).toBe(
    `https://app.example.com/dashboard/guest-experience/all?conversation=${UUID.toLowerCase()}&workspace=resort-east`
  );
});

test('double-encoded /c path still resolves to canonical location', async () => {
  CONV_MAP.set(LEGACY_ID, { legacyId: LEGACY_ID, uuid: UUID });
  mockMessagesResponse();
  const final = `https://app.example.com/dashboard/guest-experience/all?conversation=${UUID.toLowerCase()}&workspace=resort-east`;
  const wrapped = encodeURIComponent(encodeURIComponent(`https://app.example.com/c/${UUID}`));
  const app = createRedirectorApp();
  const res = await app.fetch(
    new Request(`http://redirect.example/c/${wrapped}`, { method: 'GET' }),
  );
  expect(res.status).toBe(303);
  expect(res.headers.get('location')).toBe(final);
});

test('GET /boom/open/conv/:id returns final dashboard link', async () => {
  CONV_MAP.set(LEGACY_ID, { legacyId: LEGACY_ID, uuid: UUID });
  mockMessagesResponse({ workspace: 'north-tower' });
  const app = createRedirectorApp();
  const res = await app.fetch(
    new Request('http://redirect.example/boom/open/conv/1010993', {
      method: 'GET',
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0' },
    }),
  );
  expect(res.status).toBe(303);
  expect(res.headers.get('location')).toBe(
    `https://app.example.com/dashboard/guest-experience/all?conversation=${UUID.toLowerCase()}&workspace=north-tower`
  );
});

test('GET /boom/open/conv/:id serves interstitial for Outlook webview', async () => {
  CONV_MAP.set(LEGACY_ID, { legacyId: LEGACY_ID, uuid: UUID });
  mockMessagesResponse({ workspace: 'west-wing' });
  const app = createRedirectorApp();
  const res = await app.fetch(
    new Request('http://redirect.example/boom/open/conv/1010993', {
      method: 'GET',
      headers: {
        'user-agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Outlook-iOS/2.0',
      },
    }),
  );
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/html');
  const html = await res.text();
  expect(html).toContain('Open this conversation in your browser');
  expect(html).toContain('Open in Safari');
  expect(html).toContain('window.open');
});
