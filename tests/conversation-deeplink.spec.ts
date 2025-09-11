import { test, expect } from "@playwright/test";

test("logged-out redirect preserves next and post-login redirects", async ({ page }) => {
  const convoId = "test-convo-123";
  await page.goto(`/r/conversation/${convoId}`);
  await expect(page).toHaveURL(/\/login\?next=%2Finbox%2Fconversations%2Ftest-convo-123/);

  await page.fill('input[name="email"]', "user@example.com");
  await page.fill('input[name="password"]', "password");
  await page.click('button[type="submit"]');

  await expect(page).toHaveURL(`/inbox/conversations/${convoId}`);
});

