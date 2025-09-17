import { test, expect } from '@playwright/test';
import { startTestServer, stopTestServer } from '../tests/helpers/nextServer';

// Start a Next.js server for testing the redirect.
test('cs route loads directly without redirect', async ({ page }) => {
  const { server, port } = await startTestServer();
  const q = 'conversation=test-123';
  await page.goto(`http://localhost:${port}/dashboard/guest-experience/all?${q}`, {
    waitUntil: 'domcontentloaded',
  });

  const url = new URL(page.url());
  expect(url.pathname).toBe('/dashboard/guest-experience/all');
  expect(url.searchParams.get('conversation')).toBe('test-123');

  await stopTestServer(server);
});
