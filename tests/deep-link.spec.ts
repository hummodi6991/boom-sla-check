import { test, expect } from '@playwright/test';

// Regression test: deep-link to conversation should not crash even if data is slow/empty

test('deep-link to conversation loads without runtime errors', async ({ page }) => {
  const id = 'test-123';
  await page.goto(`http://localhost:3000/dashboard/guest-experience/cs?conversation=${id}`);

  // No fatal overlay/dialog appears
  const errorDialog = page.getByText(/TypeError: undefined is not an object/);
  await expect(errorDialog).toHaveCount(0);

  // Page reaches a stable, interactive state
  await expect(page).toHaveURL(/\/dashboard\/guest-experience\/cs/);
});
