import { test, expect } from '@playwright/test';
import { buildUniversalConversationLink } from '../lib/alertLink.js';
import { verifyLinkToken } from '../apps/shared/lib/linkToken';

const ORIGINAL_LINK_SECRET = process.env.LINK_SECRET;
const ORIGINAL_RESOLVE_SECRET = process.env.RESOLVE_SECRET;
const ORIGINAL_RESOLVE_BASE_URL = process.env.RESOLVE_BASE_URL;
const ORIGINAL_APP_URL = process.env.APP_URL;
const ORIGINAL_FETCH = global.fetch;

const uuid = '123e4567-e89b-12d3-a456-426614174000';

function restoreEnv() {
  if (ORIGINAL_LINK_SECRET !== undefined) {
    process.env.LINK_SECRET = ORIGINAL_LINK_SECRET;
  } else {
    delete process.env.LINK_SECRET;
  }
  if (ORIGINAL_RESOLVE_SECRET !== undefined) {
    process.env.RESOLVE_SECRET = ORIGINAL_RESOLVE_SECRET;
  } else {
    delete process.env.RESOLVE_SECRET;
  }
  if (ORIGINAL_RESOLVE_BASE_URL !== undefined) {
    process.env.RESOLVE_BASE_URL = ORIGINAL_RESOLVE_BASE_URL;
  } else {
    delete process.env.RESOLVE_BASE_URL;
  }
  if (ORIGINAL_APP_URL !== undefined) {
    process.env.APP_URL = ORIGINAL_APP_URL;
  } else {
    delete process.env.APP_URL;
  }
  if (ORIGINAL_FETCH) {
    global.fetch = ORIGINAL_FETCH;
  } else {
    delete (global as any).fetch;
  }
}

test.afterEach(() => {
  restoreEnv();
});

const BASE = 'https://example.com';

test('buildUniversalConversationLink returns token link for uuid', async () => {
  process.env.LINK_SECRET = 'test-secret';
  const res = await buildUniversalConversationLink(
    { uuid },
    {
      baseUrl: BASE,
      verify: async (url) => {
        expect(url.startsWith(`${BASE}/r/t/`)).toBe(true);
        return true;
      },
    }
  );
  expect(res?.kind).toBe('uuid');
  expect(res?.url).toBeDefined();
  const href = res?.url ?? '';
  const parsed = new URL(href);
  expect(parsed.pathname.startsWith('/r/t/')).toBe(true);
  const token = parsed.pathname.split('/').pop();
  expect(token).toBeTruthy();
  const decoded = token ? verifyLinkToken(token) : { error: 'invalid' };
  expect('uuid' in decoded ? decoded.uuid : null).toBe(uuid);
});

test('buildUniversalConversationLink falls back to deep link when token mint fails', async () => {
  delete process.env.LINK_SECRET;
  const calls: unknown[] = [];
  const res = await buildUniversalConversationLink(
    { uuid },
    {
      baseUrl: BASE,
      verify: async (url) => {
        calls.push(url);
        expect(url).toBe(
          `${BASE}/dashboard/guest-experience/all?conversation=${encodeURIComponent(uuid)}`
        );
        return true;
      },
      onTokenError: (err) => {
        calls.push(err);
      },
    }
  );
  expect(res?.kind).toBe('uuid');
  expect(res?.url).toBe(
    `${BASE}/dashboard/guest-experience/all?conversation=${encodeURIComponent(uuid)}`
  );
  expect(calls.length).toBeGreaterThanOrEqual(2);
});

test('buildUniversalConversationLink returns legacy shortlink when uuid unavailable', async () => {
  process.env.LINK_SECRET = 'test-secret';
  delete process.env.RESOLVE_SECRET;
  delete process.env.RESOLVE_BASE_URL;
  const res = await buildUniversalConversationLink(
    { legacyId: 456 },
    {
      baseUrl: BASE,
      verify: async (url) => {
        expect(url).toBe(`${BASE}/r/legacy/456`);
        return true;
      },
    }
  );
  expect(res).toEqual({ url: `${BASE}/r/legacy/456`, kind: 'legacy' });
});

test('buildUniversalConversationLink uses slug when numeric id missing', async () => {
  process.env.LINK_SECRET = 'test-secret';
  const res = await buildUniversalConversationLink(
    { slug: 'my-convo' },
    {
      baseUrl: BASE,
      verify: async (url) => {
        expect(url).toBe(`${BASE}/r/conversation/my-convo`);
        return true;
      },
    }
  );
  expect(res).toEqual({ url: `${BASE}/r/conversation/my-convo`, kind: 'legacy' });
});

test('buildUniversalConversationLink resolves identifiers via internal endpoint', async () => {
  process.env.LINK_SECRET = 'test-secret';
  process.env.RESOLVE_SECRET = 'resolve';
  process.env.RESOLVE_BASE_URL = 'https://resolve.test';
  const fetchCalls: string[] = [];
  global.fetch = async (url: any) => {
    fetchCalls.push(String(url));
    return { ok: true, json: async () => ({ uuid }) } as any;
  };
  const res = await buildUniversalConversationLink(
    { legacyId: 'abc' },
    {
      baseUrl: BASE,
      verify: async (url) => {
        expect(url.startsWith(`${BASE}/r/t/`)).toBe(true);
        return true;
      },
    }
  );
  expect(res?.kind).toBe('uuid');
  expect(fetchCalls[0]).toContain('id=abc');
});

test('buildUniversalConversationLink returns null when verification fails', async () => {
  process.env.LINK_SECRET = 'test-secret';
  const res = await buildUniversalConversationLink(
    { uuid },
    {
      baseUrl: BASE,
      verify: async () => false,
    }
  );
  expect(res).toBeNull();
});
