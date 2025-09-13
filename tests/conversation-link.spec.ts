import { test, expect } from '@playwright/test';
import { conversationDeepLinkFromUuid } from '../apps/shared/lib/links';
import { buildAlertEmail } from '../apps/worker/mailer/alerts';
import { metrics } from '../lib/metrics';

const BASE = process.env.APP_URL ?? 'https://app.boomnow.com';
const uuid = '123e4567-e89b-12d3-a456-426614174000';

test('conversationDeepLinkFromUuid builds link', () => {
  expect(conversationDeepLinkFromUuid(uuid)).toBe(
    `${BASE}/dashboard/guest-experience/cs?conversation=${encodeURIComponent(uuid)}`
  );
});

test('conversationDeepLinkFromUuid throws for invalid uuid', () => {
  expect(() => conversationDeepLinkFromUuid('not-a-uuid')).toThrow();
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
  expect(metricsArr).toContain('alerts.skipped_producer_violation');
});

test('mailer sends when conversation_uuid present and link verifies', async () => {
  const emails: any[] = [];
  const logger = { warn: () => {} };
  const verify = async (url: string) => url.includes(uuid);
  await simulateAlert({ conversation_uuid: uuid }, {
    sendAlertEmail: (x: any) => emails.push(x),
    logger,
    verify,
  });
  expect(emails.length).toBe(1);
  expect(emails[0].html).toContain(`?conversation=${uuid}`);
});
