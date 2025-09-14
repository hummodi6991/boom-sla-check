import { test, expect } from '@playwright/test';
import { makeConversationLink } from '../apps/shared/lib/links';
import { buildAlertEmail } from '../apps/worker/mailer/alerts';
import { metrics } from '../lib/metrics';

const BASE = process.env.APP_URL ?? 'https://app.boomnow.com';
const uuid = '123e4567-e89b-12d3-a456-426614174000';

test('makeConversationLink builds ?conversation when uuid provided', () => {
  expect(makeConversationLink({ uuid })).toBe(
    `${BASE}/dashboard/guest-experience/cs?conversation=${encodeURIComponent(uuid)}`
  );
});

test('makeConversationLink builds /r/legacy when uuid missing', () => {
  expect(makeConversationLink({ legacyId: 123 })).toBe(
    `${BASE}/r/legacy/123`
  );
});

test('makeConversationLink returns null when neither id provided', () => {
  expect(makeConversationLink({})).toBeNull();
});

async function simulateAlert(event: any, deps: any) {
  const { sendAlertEmail, logger, verify } = deps;
  const html = await buildAlertEmail(event, { logger, verify });
  if (html) await sendAlertEmail({ html });
}

test('mailer skips when both uuid and legacyId missing', async () => {
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
  const verify = async (url: string) => url.includes(uuid);
  const orig = metrics.increment;
  metrics.increment = (n: string) => metricsArr.push(n);
  await simulateAlert({ conversation_uuid: uuid }, {
    sendAlertEmail: (x: any) => emails.push(x),
    logger,
    verify,
  });
  metrics.increment = orig;
  expect(emails.length).toBe(1);
  expect(emails[0].html).toContain(`?conversation=${uuid}`);
  expect(metricsArr).toContain('alerts.sent_with_uuid');
});

test('mailer falls back to legacyId when uuid missing', async () => {
  const emails: any[] = [];
  const metricsArr: string[] = [];
  const logger = { warn: () => {} };
  const verify = async (url: string) => url.includes('/r/legacy/123');
  const orig = metrics.increment;
  metrics.increment = (n: string) => metricsArr.push(n);
  await simulateAlert({ legacyId: 123 }, {
    sendAlertEmail: (x: any) => emails.push(x),
    logger,
    verify,
  });
  metrics.increment = orig;
  expect(emails.length).toBe(1);
  expect(emails[0].html).toContain(`/r/legacy/123`);
  expect(metricsArr).toContain('alerts.sent_with_legacyId');
});
