import { test, expect } from "@playwright/test";

test("logged-out: redirect to login, then to conversation", async ({ page, context }) => {
  // Start logged out (new context has no cookies)
  const convoId = "test-convo-123";
  await page.goto(`/r/conversation/${convoId}`);

  await expect(page).toHaveURL(/\/login\?next=%2Finbox%2Fconversations%2Ftest-convo-123/);

  // Perform login helper (replace with your real flow/selectors)
  await page.fill('input[name="email"]', "user@example.com");
  await page.fill('input[name="password"]', "password");
  await page.click('button[type="submit"]');

  await expect(page).toHaveURL(`/inbox/conversations/${convoId}`);
  await expect(page.locator('[data-testid="conversation-view"]')).toBeVisible();
});

test("logged-in: direct to conversation", async ({ page }) => {
  // Pre-auth helper (adjust to your app; or use API to set session cookie)
  await page.goto("/login");
  // ... fill & submit ...
  // Now navigate
  const convoId = "test-convo-456";
  await page.goto(`/r/conversation/${convoId}`);
  await expect(page).toHaveURL(`/inbox/conversations/${convoId}`);
});
