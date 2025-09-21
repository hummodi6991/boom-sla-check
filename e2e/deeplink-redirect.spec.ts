import { test, expect } from '@playwright/test';
import { startTestServer, stopTestServer } from '../tests/helpers/nextServer';
import { setTestKeyEnv } from '../tests/helpers/testKeys';
import { startRedirectorServer, stopRedirectorServer } from '../tests/helpers/redirectorServer';
import { buildAlertEmail } from '../apps/worker/mailer/alerts';
import { prisma } from '../lib/db';

const uuid = '01890b14-b4cd-7eef-b13e-bb8c083bad60';
const legacyUuid = '01890b14-b4cd-7eef-b13e-bb8c083bad61';
const slugUuid = '01890b14-b4cd-7eef-b13e-bb8c083bad62';
const legacyId = 991130;
const slugToken = 'suite-guest';

test.use({ ignoreHTTPSErrors: true });

test.beforeEach(() => {
  setTestKeyEnv();
  prisma.conversation._data.clear();
  prisma.conversation_aliases._data.clear();
});

test('mailer link flows through redirector to deep link', async ({ page }) => {
  setTestKeyEnv();
  const originalAlertBase = process.env.ALERT_LINK_BASE;
  const originalTarget = process.env.TARGET_APP_URL;
  const { server: appServer, port: appPort } = await startTestServer();
  process.env.TARGET_APP_URL = `http://localhost:${appPort}`;
  const redirect = await startRedirectorServer();
  process.env.ALERT_LINK_BASE = `http://localhost:${redirect.port}`;

  try {
    const html = await buildAlertEmail({ conversation_uuid: uuid });
    const match = html?.match(/href="([^"]+)"/i);
    const href = match?.[1];
    expect(href).toBeTruthy();
    await page.goto(href ?? '', { waitUntil: 'domcontentloaded' });
    const u = new URL(page.url());
    expect(u.pathname).toBe('/dashboard/guest-experience/all');
    expect(u.searchParams.get('conversation')).toBe(uuid);
  } finally {
    await stopRedirectorServer(redirect);
    await stopTestServer(appServer);
    if (originalAlertBase !== undefined) {
      process.env.ALERT_LINK_BASE = originalAlertBase;
    } else {
      delete process.env.ALERT_LINK_BASE;
    }
    if (originalTarget !== undefined) {
      process.env.TARGET_APP_URL = originalTarget;
    } else {
      delete process.env.TARGET_APP_URL;
    }
  }
});

test('go/c/<uuid> loads conversation view', async ({ page }) => {
  const { server, port } = await startTestServer();
  await page.goto(`http://localhost:${port}/go/c/${uuid}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/TypeError: undefined is not an object/i)).toHaveCount(0);
  await expect(page.locator('[data-uuid]')).toHaveAttribute('data-uuid', uuid.toLowerCase());
  await expect(page).toHaveURL(/\/dashboard\/guest-experience\/all/);
  await stopTestServer(server);
});

test('go/c/<legacy-id> resolves to canonical conversation', async ({ page }) => {
  prisma.conversation._data.set(legacyId, { uuid: legacyUuid, slug: slugToken });
  const { server, port } = await startTestServer();
  await page.goto(`http://localhost:${port}/go/c/${legacyId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-uuid]')).toHaveAttribute('data-uuid', legacyUuid.toLowerCase());
  await expect(page).toHaveURL(/\/dashboard\/guest-experience\/all/);
  await stopTestServer(server);
});

test('deep-link renders without runtime TypeError', async ({ page }) => {
  prisma.conversation._data.set(legacyId + 1, { uuid: slugUuid, slug: slugToken });
  const { server, port } = await startTestServer();
  await page.goto(`http://localhost:${port}/go/c/${slugToken}`, {
    waitUntil: 'domcontentloaded',
  });
  await expect(page.getByText(/TypeError: undefined is not an object/i)).toHaveCount(0);
  await expect(page).toHaveURL(/\/dashboard\/guest-experience\/all/);
  await expect(page.locator('[data-uuid]')).toHaveAttribute('data-uuid', slugUuid.toLowerCase());
  await stopTestServer(server);
});
