import { test, expect } from '@playwright/test';
import { makeConversationLink } from '../apps/shared/lib/links';
import { verifyLinkToken } from '../apps/shared/lib/linkToken';
import { buildAlertEmail } from '../apps/worker/mailer/alerts';
import { metrics } from '../lib/metrics';
import { mintUuidFromRaw } from '../apps/shared/lib/canonicalConversationUuid.js';
import {
  buildAlertConversationLink,
  normalizeAlertLinkInput,
} from '../lib/conversationLink.js';
import { setTestKeyEnv } from './helpers/testKeys';

const BASE = process.env.APP_URL ?? 'https://app.boomnow.com';
const uuid = '01890b14-b4cd-7eef-b13e-bb8c083bad60';
const ORIGINAL_PRIVATE_KEY = process.env.LINK_PRIVATE_KEY_PEM;
const ORIGINAL_PUBLIC_KEY = process.env.LINK_PUBLIC_KEY_PEM;
const ORIGINAL_SIGNING_KID = process.env.LINK_SIGNING_KID;
const ORIGINAL_RESOLVE_SECRET = process.env.RESOLVE_SECRET;
const ORIGINAL_RESOLVE_BASE_URL = process.env.RESOLVE_BASE_URL;

test.beforeEach(() => {
  setTestKeyEnv();
});

test.afterEach(() => {
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
});

test('makeConversationLink builds ?conversation when uuid provided', () => {
  expect(makeConversationLink({ uuid })).toBe(
    `${BASE}/dashboard/guest-experience/all?conversation=${encodeURIComponent(uuid)}`
  );
});

test('makeConversationLink accepts baseUrl override', () => {
  expect(
    makeConversationLink({ uuid, baseUrl: 'http://localhost:4321' })
  ).toBe(`http://localhost:4321/dashboard/guest-experience/all?conversation=${uuid}`);
});

test('makeConversationLink returns null when uuid missing', () => {
  expect(makeConversationLink({})).toBeNull();
});

test('normalizeAlertLinkInput extracts identifiers from event payload', () => {
  const normalized = normalizeAlertLinkInput({
    conversation_uuid: uuid,
    legacyId: 123,
    conversation: { slug: 'guest-slug' },
  });
  expect(normalized).toEqual(
    expect.objectContaining({ uuid: uuid.toLowerCase(), legacyId: '123', slug: 'guest-slug' })
  );
});

test('buildAlertConversationLink produces verified link with id display', async () => {
  const built = await buildAlertConversationLink(
    { conversation_uuid: uuid },
    { baseUrl: BASE, verify: async () => true, strictUuid: true }
  );
  expect(built?.url).toMatch(/\/r\/(t|conversation)\/|conversation=/);
  expect(built?.idDisplay).toBe(uuid.toLowerCase());
});

async function simulateAlert(event: any, deps: any) {
  const { sendAlertEmail, logger, verify } = deps;
  const html = await buildAlertEmail(event, { logger, verify });
  if (html) await sendAlertEmail({ html });
}

test('mailer skips when conversation_uuid missing', async () => {
  const logs: any[] = [];
  const metricsArr: string[] = [];
  const emails: any[] = [];
  const logger = { warn: (...args: any[]) => logs.push(args) };
  const orig = metrics.increment;
  metrics.increment = (n: string) => metricsArr.push(n);
  await simulateAlert({}, {
    sendAlertEmail: (x: any) => emails.push(x),
    logger,
    verify: async () => true,
  });
  metrics.increment = orig;
  expect(emails.length).toBe(0);
  expect(metricsArr).toContain('alerts.skipped_no_uuid');
});

test('mailer uses uuid when available', async () => {
  const emails: any[] = [];
  const metricsArr: string[] = [];
  const logger = { warn: () => {} };
  const verify = async (url: string) => {
    if (!url.includes('/r/t/')) return false;
    const match = url.match(/\/r\/t\/([^/?#]+)/);
    if (!match) return false;
    const res = await verifyLinkToken(match[1]);
    return res.payload?.conversation === uuid;
  };
  const orig = metrics.increment;
  metrics.increment = (n: string) => metricsArr.push(n);
  await simulateAlert({ conversation_uuid: uuid }, {
    sendAlertEmail: (x: any) => emails.push(x),
    logger,
    verify,
  });
  metrics.increment = orig;
  expect(emails.length).toBe(1);
  expect(emails[0].html).toContain('/r/t/');
  const href = emails[0].html.match(/href="([^"]+)"/i)?.[1];
  expect(href).toBeDefined();
  const parsed = href ? new URL(href) : null;
  expect(parsed?.pathname.startsWith('/r/t/')).toBe(true);
  const token = parsed?.pathname.split('/').pop();
  if (!token) throw new Error('missing token in href');
  const decoded = await verifyLinkToken(token);
  expect(decoded.payload?.conversation).toBe(uuid);
  expect(emails[0].html).toContain('Backup deep link');
  expect(metricsArr).toContain('alerts.sent_with_token_link');
});

test('mailer resolves legacyId via internal endpoint and emits token link', async () => {
  process.env.RESOLVE_SECRET = 'secret';
  process.env.RESOLVE_BASE_URL = BASE;
  const emails: any[] = [];
  const metricsArr: string[] = [];
  const logger = { warn: () => {} };
  const oldFetch = global.fetch;
  // Stub internal resolver
  global.fetch = async (_url: any) => ({ ok: true, json: async () => ({ uuid }) } as any);
  const verify = async (url: string) => {
    const m = url.match(/\/r\/t\/([^/?#]+)/);
    if (!m) return false;
    const decoded = await verifyLinkToken(m[1]);
    return decoded.payload?.conversation === uuid;
  };
  const orig = metrics.increment;
  metrics.increment = (n: string) => metricsArr.push(n);
  await simulateAlert({ legacyId: 456 }, {
    sendAlertEmail: (x: any) => emails.push(x),
    logger,
    verify,
  });
  metrics.increment = orig;
  global.fetch = oldFetch;
  expect(emails.length).toBe(1);
  const href = emails[0].html.match(/href="([^"]+)"/i)?.[1];
  expect(href).toBeDefined();
  expect(href).toContain('/r/t/');
  expect(metricsArr).toContain('alerts.sent_with_token_link');
});

test('mailer mints uuid when canonical mapping missing (strict mode)', async () => {
  delete process.env.RESOLVE_SECRET;
  delete process.env.RESOLVE_BASE_URL;
  const emails: any[] = [];
  const metricsArr: string[] = [];
  const logger = { warn: () => {} };
  const verify = async () => true;
  const orig = metrics.increment;
  const originalTryResolve = (globalThis as any).tryResolveConversationUuid;
  (globalThis as any).tryResolveConversationUuid = async () => null;
  metrics.increment = (n: string) => metricsArr.push(n);
  await simulateAlert({ legacyId: 789 }, {
    sendAlertEmail: (x: any) => emails.push(x),
    logger,
    verify,
  });
  metrics.increment = orig;
  if (originalTryResolve) {
    (globalThis as any).tryResolveConversationUuid = originalTryResolve;
  } else {
    delete (globalThis as any).tryResolveConversationUuid;
  }
  expect(emails.length).toBe(1);
  const minted = mintUuidFromRaw('789');
  expect(emails[0].html).toContain(`conversation=${encodeURIComponent(minted ?? '')}`);
  expect(metricsArr).toContain('alerts.sent_with_minted_link');
});

test('mailer mints uuid for slug when resolver unavailable', async () => {
  delete process.env.RESOLVE_SECRET;
  delete process.env.RESOLVE_BASE_URL;
  const slug = 'my-convo';
  const emails: any[] = [];
  const metricsArr: string[] = [];
  const logger = { warn: () => {} };
  const verify = async () => true;
  const orig = metrics.increment;
  const originalTryResolve = (globalThis as any).tryResolveConversationUuid;
  (globalThis as any).tryResolveConversationUuid = async () => null;
  metrics.increment = (n: string) => metricsArr.push(n);
  await simulateAlert({ slug }, {
    sendAlertEmail: (x: any) => emails.push(x),
    logger,
    verify,
  });
  metrics.increment = orig;
  if (originalTryResolve) {
    (globalThis as any).tryResolveConversationUuid = originalTryResolve;
  } else {
    delete (globalThis as any).tryResolveConversationUuid;
  }
  expect(emails.length).toBe(1);
  const minted = mintUuidFromRaw(slug);
  expect(emails[0].html).toContain(`conversation=${encodeURIComponent(minted ?? '')}`);
  expect(metricsArr).toContain('alerts.sent_with_minted_link');
});
