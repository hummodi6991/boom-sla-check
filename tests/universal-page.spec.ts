import { test, expect } from '@playwright/test';
import { startTestServer, stopTestServer } from './helpers/nextServer';
const uuid = '123e4567-e89b-12d3-a456-426614174000';

test('legacyId resolves to conversation uuid on page', async ({ page }) => {
  const { server, port } = await startTestServer();
  await page.route('**/api/resolve/conversation**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('legacyId') !== '456') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ uuid }),
      headers: { 'Cache-Control': 'no-store' },
    });
  });
  await page.goto(`http://localhost:${port}/dashboard/guest-experience/cs?legacyId=456`);
  await expect(page.locator('[data-uuid]')).toHaveAttribute('data-uuid', uuid, { timeout: 15000 });
  await stopTestServer(server);
});
