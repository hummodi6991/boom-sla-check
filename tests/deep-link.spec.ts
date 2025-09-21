import { test, expect } from '@playwright/test';
import { startTestServer, stopTestServer } from './helpers/nextServer';

// Regression test: deep-link to conversation should not crash even if data is slow/empty

test('deep-link to conversation loads without runtime errors', async ({ page }) => {
  const { server, port } = await startTestServer();
  const id = 'test-123';
  await page.goto(`http://localhost:${port}/go/c/${id}`);

  // No fatal overlay/dialog appears
  const errorDialog = page.getByText(/TypeError: undefined is not an object/);
  await expect(errorDialog).toHaveCount(0);

  // Unknown conversations render a friendly not-found page without crashing
  await expect(page).toHaveURL(new RegExp(`/go/c/${id}$`));
  await expect(page.getByRole('heading', { name: /conversation not found/i })).toBeVisible();
  await stopTestServer(server);
});
