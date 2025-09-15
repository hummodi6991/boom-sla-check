import { test, expect } from '@playwright/test';
import { startTestServer, stopTestServer } from '../tests/helpers/nextServer';

test('legacy shortlink redirects to deep link', async ({ page }) => {
  const { server, port } = await startTestServer();
  await page.goto(`http://localhost:${port}/r/conversation/abc123?from=email`, { waitUntil: 'domcontentloaded' });
  const u = new URL(page.url());
  expect(u.pathname).toBe('/dashboard/guest-experience/cs');
  expect(u.searchParams.get('conversation')).toBe('abc123');
  expect(u.searchParams.get('from')).toBeNull();
  await stopTestServer(server);
});

test('deep-link renders without runtime TypeError', async ({ page }) => {
  const { server, port } = await startTestServer();
  await page.goto(
    `http://localhost:${port}/dashboard/guest-experience/cs?conversation=test-123`,
    { waitUntil: 'domcontentloaded' },
  );
  await expect(page.getByText(/TypeError: undefined is not an object/i)).toHaveCount(0);
  await expect(page).toHaveURL(/\/dashboard\/guest-experience\/cs/);
  await stopTestServer(server);
});
