import { test, expect } from '@playwright/test';
import { makeConversationLink } from '../apps/shared/lib/links';
import { verifyLinkToken } from '../apps/shared/lib/linkToken';
import { buildAlertEmail } from '../apps/worker/mailer/alerts';
import { metrics } from '../lib/metrics';

const BASE = process.env.APP_URL ?? 'https://app.boomnow.com';
const uuid = '123e4567-e89b-12d3-a456-426614174000';
const ORIGINAL_LINK_SECRET = process.env.LINK_SECRET;
const ORIGINAL_RESOLVE_SECRET = process.env.RESOLVE_SECRET;
const ORIGINAL_RESOLVE_BASE_URL = process.env.RESOLVE_BASE_URL;

function ensureLinkSecret() {
  if (!process.env.LINK_SECRET) {
    process.env.LINK_SECRET = 'test-secret';
  }
}

test.beforeEach(() => {
  ensureLinkSecret();
});

test.afterEach(() => {
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
});

test('makeConversationLink builds ?conversation when uuid provided', () => {
  expect(makeConversationLink({ uuid })).toBe(
    `${BASE}/dashboard/guest-experience/cs?conversation=${encodeURIComponent(uuid)}`
  );
});

test('makeConversationLink accepts baseUrl override', () => {
  expect(
    makeConversationLink({ uuid, baseUrl: 'http://localhost:4321' })
  ).toBe('http://localhost:4321/dashboard/guest-experience/cs?conversation=123e4567-e89b-12d3-a456-426614174000');
});

test('makeConversationLink returns null when uuid missing', () => {
  expect(makeConversationLink({})).toBeNull();
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
  expect(metricsArr).toContain('alerts.skipped_missing_uuid');
});

test('mailer uses uuid when available', async () => {
  const emails: any[] = [];
  const metricsArr: string[] = [];
  const logger = { warn: () => {} };
  const verify = async (url: string) => {
    if (!url.includes('/r/t/')) return false;
    const match = url.match(/\/r\/t\/([^/?#]+)/);
    if (!match) return false;
    const res = verifyLinkToken(match[1]);
    return 'uuid' in res && res.uuid === uuid;
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
  const decoded = verifyLinkToken(token);
  expect('uuid' in decoded ? decoded.uuid : null).toBe(uuid);
  expect(metricsArr).toContain('alerts.sent_with_uuid');
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
    const decoded = verifyLinkToken(m[1]);
    return 'uuid' in decoded && decoded.uuid === uuid;
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
  expect(metricsArr).toContain('alerts.sent_with_uuid');
});

test('mailer falls back to legacy shortlink when uuid unavailable', async () => {
  delete process.env.RESOLVE_SECRET;
  delete process.env.RESOLVE_BASE_URL;
  const emails: any[] = [];
  const metricsArr: string[] = [];
  const logger = { warn: () => {} };
  const expected = `${BASE}/r/legacy/789`;
  const verify = async (url: string) => {
    expect(url).toBe(expected);
    return true;
  };
  const orig = metrics.increment;
  metrics.increment = (n: string) => metricsArr.push(n);
  await simulateAlert({ legacyId: 789 }, {
    sendAlertEmail: (x: any) => emails.push(x),
    logger,
    verify,
  });
  metrics.increment = orig;
  expect(emails.length).toBe(1);
  expect(emails[0].html).toContain(expected);
  expect(metricsArr).toContain('alerts.sent_with_legacy_shortlink');
});

test('mailer falls back to conversation slug when numeric id absent', async () => {
  delete process.env.RESOLVE_SECRET;
  delete process.env.RESOLVE_BASE_URL;
  const slug = 'my-convo';
  const expected = `${BASE}/r/conversation/${encodeURIComponent(slug)}`;
  const emails: any[] = [];
  const metricsArr: string[] = [];
  const logger = { warn: () => {} };
  const verify = async (url: string) => {
    expect(url).toBe(expected);
    return true;
  };
  const orig = metrics.increment;
  metrics.increment = (n: string) => metricsArr.push(n);
  await simulateAlert({ slug }, {
    sendAlertEmail: (x: any) => emails.push(x),
    logger,
    verify,
  });
  metrics.increment = orig;
  expect(emails.length).toBe(1);
  expect(emails[0].html).toContain(expected);
  expect(metricsArr).toContain('alerts.sent_with_legacy_shortlink');
});
