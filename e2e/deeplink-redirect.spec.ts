import { test, expect } from '@playwright/test';
import { startTestServer, stopTestServer } from '../tests/helpers/nextServer';
import { makeLinkToken } from '../apps/shared/lib/linkToken';

const uuid = '01890b14-b4cd-7eef-b13e-bb8c083bad60';

test.use({ ignoreHTTPSErrors: true });

test.beforeEach(() => {
  process.env.LINK_SECRET = 'test-secret';
});

test('token shortlink redirects to deep link', async ({ page }) => {
  const { server, port } = await startTestServer();
  process.env.APP_URL = `http://localhost:${port}`;
  const token = makeLinkToken({ uuid, exp: Math.floor(Date.now() / 1000) + 60 });
  await page.goto(`http://localhost:${port}/r/t/${token}?from=email`, {
    waitUntil: 'domcontentloaded',
  });
  const u = new URL(page.url());
  expect(u.pathname).toBe('/dashboard/guest-experience/all');
  expect(u.searchParams.get('conversation')).toBe(uuid);
  expect(u.searchParams.get('from')).toBeNull();
  await stopTestServer(server);
});

test('deep-link renders without runtime TypeError', async ({ page }) => {
  const { server, port } = await startTestServer();
  await page.goto(
    `http://localhost:${port}/dashboard/guest-experience/all?conversation=test-123`,
    { waitUntil: 'domcontentloaded' },
  );
  await expect(page.getByText(/TypeError: undefined is not an object/i)).toHaveCount(0);
  await expect(page).toHaveURL(/\/dashboard\/guest-experience\/all/);
  await stopTestServer(server);
});
