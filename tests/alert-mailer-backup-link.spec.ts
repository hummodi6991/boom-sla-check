import { test, expect } from '@playwright/test';
import { buildAlertEmail } from '../apps/worker/mailer/alerts';

const UUID = '123e4567-e89b-12d3-a456-426614174000';

test('backup deep link uses APP_URL host (not ALERT_LINK_BASE)', async () => {
  const prevAppUrl = process.env.APP_URL;
  const prevAlertBase = process.env.ALERT_LINK_BASE;
  const prevPriv = process.env.LINK_PRIVATE_JWK;
  // Ensure token signing is skipped so primary becomes a deep link and we can still render HTML.
  delete process.env.LINK_PRIVATE_JWK;
  process.env.APP_URL = 'https://app.example';
  process.env.ALERT_LINK_BASE = 'https://go.example';
  try {
    const html = await buildAlertEmail(
      { conversation_uuid: UUID },
      { verify: async () => true },
    );
    expect(html).toBeTruthy();
    const m = html!.match(/Backup deep link: <a href="([^"]+)"/i);
    expect(m?.[1]).toBeTruthy();
    expect(m![1].startsWith('https://app.example/go/c/')).toBeTruthy();
  } finally {
    if (prevAppUrl !== undefined) process.env.APP_URL = prevAppUrl; else delete process.env.APP_URL;
    if (prevAlertBase !== undefined) process.env.ALERT_LINK_BASE = prevAlertBase; else delete process.env.ALERT_LINK_BASE;
    if (prevPriv !== undefined) process.env.LINK_PRIVATE_JWK = prevPriv; else delete process.env.LINK_PRIVATE_JWK;
  }
});

