import { test, expect } from '@playwright/test';
import { buildUniversalConversationLink } from '../lib/alertLink.js';
import { verifyLinkToken } from '../apps/shared/lib/linkToken';
import { mintUuidFromRaw } from '../apps/shared/lib/canonicalConversationUuid.js';
import { setTestKeyEnv } from './helpers/testKeys';

const ORIGINAL_PRIVATE_KEY = process.env.LINK_PRIVATE_KEY_PEM;
const ORIGINAL_PUBLIC_KEY = process.env.LINK_PUBLIC_KEY_PEM;
const ORIGINAL_SIGNING_KID = process.env.LINK_SIGNING_KID;
const ORIGINAL_JWKS_URL = process.env.LINK_JWKS_URL;
const ORIGINAL_RESOLVE_SECRET = process.env.RESOLVE_SECRET;
const ORIGINAL_RESOLVE_BASE_URL = process.env.RESOLVE_BASE_URL;
const ORIGINAL_APP_URL = process.env.APP_URL;
const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_TRY_RESOLVE = (globalThis as any).tryResolveConversationUuid;
const ORIGINAL_RESOLVE_CONVERSATION = (globalThis as any).resolveConversationUuid;

const uuid = '123e4567-e89b-12d3-a456-426614174000';

function restoreEnv() {
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
  if (ORIGINAL_JWKS_URL !== undefined) {
    process.env.LINK_JWKS_URL = ORIGINAL_JWKS_URL;
  } else {
    delete process.env.LINK_JWKS_URL;
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
  if (ORIGINAL_TRY_RESOLVE) {
    (globalThis as any).tryResolveConversationUuid = ORIGINAL_TRY_RESOLVE;
  } else {
    delete (globalThis as any).tryResolveConversationUuid;
  }
  if (ORIGINAL_RESOLVE_CONVERSATION) {
    (globalThis as any).resolveConversationUuid = ORIGINAL_RESOLVE_CONVERSATION;
  } else {
    delete (globalThis as any).resolveConversationUuid;
  }
}

test.afterEach(() => {
  restoreEnv();
});

test.beforeEach(() => {
  setTestKeyEnv();
});

const BASE = 'https://example.com';

test('buildUniversalConversationLink returns token link for uuid', async () => {
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
  expect(res?.kind).toBe('token');
  expect(res?.url).toBeDefined();
  const href = res?.url ?? '';
  const parsed = new URL(href);
  expect(parsed.pathname.startsWith('/r/t/')).toBe(true);
  const token = parsed.pathname.split('/').pop();
  expect(token).toBeTruthy();
  const decoded = token ? await verifyLinkToken(token) : null;
  expect(decoded?.payload?.conversation).toBe(uuid);
});

test('buildUniversalConversationLink degrades to deep link when token verification fails', async () => {
  const calls: string[] = [];
  const deep = `${BASE}/dashboard/guest-experience/all?conversation=${encodeURIComponent(uuid)}`;
  const res = await buildUniversalConversationLink(
    { uuid },
    {
      baseUrl: BASE,
      verify: async (url) => {
        calls.push(url);
        if (url.startsWith(`${BASE}/r/t/`)) return false;
        if (url === deep) return true;
        return false;
      },
    }
  );
  expect(res?.kind).toBe('deep-link');
  expect(res?.url).toBe(deep);
  expect(calls).toHaveLength(2);
  expect(calls[0]?.startsWith(`${BASE}/r/t/`)).toBe(true);
  expect(calls[1]).toBe(deep);
});

test('buildUniversalConversationLink falls back to deep link when token mint fails', async () => {
  delete process.env.LINK_PRIVATE_KEY_PEM;
  delete process.env.LINK_PUBLIC_KEY_PEM;
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
  expect(res?.kind).toBe('deep-link');
  expect(res?.url).toBe(
    `${BASE}/dashboard/guest-experience/all?conversation=${encodeURIComponent(uuid)}`
  );
  expect(calls.length).toBeGreaterThanOrEqual(2);
});

test('buildUniversalConversationLink mints fallback uuid when strict mode enabled', async () => {
  const slug = 'no-alias';
  const res = await buildUniversalConversationLink(
    { slug },
    { baseUrl: BASE, verify: async () => true, strictUuid: true }
  );
  const expected = `${BASE}/r/conversation/${encodeURIComponent(slug)}`;
  expect(res?.kind).toBe('resolver');
  expect(res?.minted).toBe(true);
  expect(res?.url).toBe(expected);
});

test('buildUniversalConversationLink uses resolver(s) to obtain uuid; mints when still unresolved', async () => {
  delete process.env.RESOLVE_SECRET;
  delete process.env.RESOLVE_BASE_URL;
  const legacyId = 456;
  const res = await buildUniversalConversationLink(
    { legacyId },
    { baseUrl: BASE, verify: async () => true, strictUuid: true }
  );
  const expected = `${BASE}/r/legacy/${encodeURIComponent(String(legacyId))}`;
  expect(res?.kind).toBe('resolver');
  expect(res?.minted).toBe(true);
  expect(res?.url).toBe(expected);
});

test('buildUniversalConversationLink uses resolveConversationUuid when available', async () => {
  const resolveCalls: Array<{ raw: string }> = [];
  (globalThis as any).resolveConversationUuid = async (raw: string) => {
    resolveCalls.push({ raw });
    return uuid;
  };
  const fetchCalls: string[] = [];
  global.fetch = async (url: any) => {
    fetchCalls.push(String(url));
    return {} as any;
  };
  const res = await buildUniversalConversationLink(
    { slug: 'via-hook' },
    {
      baseUrl: BASE,
      verify: async (url) => {
        expect(url.startsWith(`${BASE}/r/t/`)).toBe(true);
        return true;
      },
    }
  );
  expect(resolveCalls).toEqual([{ raw: 'via-hook' }]);
  expect(fetchCalls).toHaveLength(0);
  expect(res?.kind).toBe('token');
});

test('buildUniversalConversationLink resolves identifiers via internal endpoint', async () => {
  process.env.RESOLVE_SECRET = 'resolve';
  process.env.RESOLVE_BASE_URL = 'https://resolve.test';
  const resolveCalls: string[] = [];
  (globalThis as any).resolveConversationUuid = async (raw: string) => {
    resolveCalls.push(raw);
    return null;
  };
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
  expect(res?.kind).toBe('token');
  expect(fetchCalls[0]).toContain('id=abc');
  expect(resolveCalls).toEqual(['abc']);
});

test('buildUniversalConversationLink uses resolver link when resolver mints uuid for legacyId', async () => {
  process.env.RESOLVE_SECRET = 'resolve';
  process.env.RESOLVE_BASE_URL = 'https://resolve.test';
  global.fetch = async (_url: any) => ({ ok: true, json: async () => ({ uuid, minted: true }) } as any);
  const seen: string[] = [];
  const legacyId = 987;
  const res = await buildUniversalConversationLink(
    { legacyId },
    {
      baseUrl: BASE,
      verify: async (url) => {
        seen.push(url);
        return true;
      },
    }
  );
  const expected = `${BASE}/r/legacy/${encodeURIComponent(String(legacyId))}`;
  expect(res?.kind).toBe('resolver');
  expect(res?.minted).toBe(true);
  expect(res?.url).toBe(expected);
  expect(seen).toEqual([expected]);
});

test('buildUniversalConversationLink uses resolver link when resolver mints uuid for slug', async () => {
  process.env.RESOLVE_SECRET = 'resolve';
  process.env.RESOLVE_BASE_URL = 'https://resolve.test';
  global.fetch = async (_url: any) => ({ ok: true, json: async () => ({ uuid, minted: true }) } as any);
  const seen: string[] = [];
  const slug = 'sluggy';
  const res = await buildUniversalConversationLink(
    { slug },
    {
      baseUrl: BASE,
      verify: async (url) => {
        seen.push(url);
        return true;
      },
    }
  );
  const expected = `${BASE}/r/conversation/${encodeURIComponent(slug)}`;
  expect(res?.kind).toBe('resolver');
  expect(res?.minted).toBe(true);
  expect(res?.url).toBe(expected);
  expect(seen).toEqual([expected]);
});

test('buildUniversalConversationLink detects minted fallback without resolver details', async () => {
  process.env.APP_URL = BASE;
  delete process.env.RESOLVE_SECRET;
  delete process.env.RESOLVE_BASE_URL;
  const slug = 'fallback-slug';
  const minted = mintUuidFromRaw(slug);
  const seen: string[] = [];
  const res = await buildUniversalConversationLink(
    { uuid: minted, slug },
    {
      baseUrl: BASE,
      verify: async (url) => {
        seen.push(url);
        return true;
      },
    }
  );
  const expected = `${BASE}/r/conversation/${encodeURIComponent(slug)}`;
  expect(res?.kind).toBe('resolver');
  expect(res?.minted).toBe(true);
  expect(res?.url).toBe(expected);
  expect(seen).toEqual([expected]);
});

test('buildUniversalConversationLink falls back to internal resolver when resolve API fails', async () => {
  process.env.RESOLVE_SECRET = 'resolve';
  process.env.RESOLVE_BASE_URL = 'https://resolve.test';
  const resolveCalls: string[] = [];
  (globalThis as any).resolveConversationUuid = async (raw: string) => {
    resolveCalls.push(raw);
    return null;
  };
  const fetchCalls: string[] = [];
  global.fetch = async (url: any) => {
    fetchCalls.push(String(url));
    return { ok: false } as any;
  };
  const tryResolveCalls: Array<{ raw: string; opts: Record<string, unknown> }> = [];
  (globalThis as any).tryResolveConversationUuid = async (
    raw: string,
    opts: Record<string, unknown>
  ) => {
    tryResolveCalls.push({ raw, opts });
    return uuid;
  };
  const res = await buildUniversalConversationLink(
    { slug: 'needs-fallback' },
    {
      baseUrl: BASE,
      verify: async (url) => {
        expect(url.startsWith(`${BASE}/r/t/`)).toBe(true);
        return true;
      },
    }
  );
  expect(res?.kind).toBe('token');
  expect(fetchCalls).toHaveLength(2);
  expect(resolveCalls).toEqual(['needs-fallback']);
  expect(tryResolveCalls).toEqual([
    {
      raw: 'needs-fallback',
      opts: expect.objectContaining({ skipRedirectProbe: true }),
    },
  ]);
});

test('buildUniversalConversationLink returns null when verification fails', async () => {
  const res = await buildUniversalConversationLink(
    { uuid },
    {
      baseUrl: BASE,
      verify: async () => false, // both token and deep link fail -> null
    }
  );
  expect(res).toBeNull();
});

test('buildUniversalConversationLink verifies resolver link when resolver indicates minted uuid', async () => {
  process.env.RESOLVE_SECRET = 'resolve';
  process.env.RESOLVE_BASE_URL = 'https://resolve.test';
  const originalFetch = global.fetch;
  global.fetch = async (url: any) => {
    const href = String(url);
    if (href.includes('/api/internal/resolve-conversation') && href.includes('id=12345')) {
      return { ok: true, json: async () => ({ uuid, minted: true }) } as any;
    }
    return { ok: true, json: async () => ({}) } as any;
  };
  const legacyId = '12345';
  const expected = `${BASE}/r/legacy/${encodeURIComponent(legacyId)}`;
  const res = await buildUniversalConversationLink(
    { uuid, legacyId },
    {
      baseUrl: BASE,
      verify: async (href) => {
        expect(href).toBe(expected);
        return true;
      },
      strictUuid: true,
    }
  );
  global.fetch = originalFetch as any;
  expect(res?.kind).toBe('resolver');
  expect(res?.minted).toBe(true);
  expect(res?.url).toBe(expected);
});

test('buildUniversalConversationLink falls back to deep link when token verification fails', async () => {
  const res = await buildUniversalConversationLink(
    { uuid },
    {
      baseUrl: BASE,
      verify: async (url) => {
        // Simulate prod: /r/t/... does NOT redirect (fail), but deep link works.
        return !/\/r\/t\//.test(url);
      },
    }
  );
  expect(res?.kind).toBe('deep-link');
  expect(res?.url).toBe(`${BASE}/dashboard/guest-experience/all?conversation=${encodeURIComponent(uuid)}`);
});

test('buildUniversalConversationLink uses resolver link for minted identifiers even when strict mode disabled', async () => {
  process.env.RESOLVE_SECRET = 'resolve';
  process.env.RESOLVE_BASE_URL = 'https://resolve.test';
  global.fetch = async (_url: any) => ({ ok: true, json: async () => ({ uuid, minted: true }) } as any);
  const seen: string[] = [];
  const legacyId = 654;
  const res = await buildUniversalConversationLink(
    { legacyId },
    {
      baseUrl: BASE,
      strictUuid: false,
      verify: async (url) => {
        seen.push(url);
        return true;
      },
    }
  );
  const expected = `${BASE}/r/legacy/${encodeURIComponent(String(legacyId))}`;
  expect(res?.kind).toBe('resolver');
  expect(res?.minted).toBe(true);
  expect(res?.url).toBe(expected);
  expect(seen).toEqual([expected]);
});
