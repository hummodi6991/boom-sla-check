import { test, expect } from '@playwright/test';
import { prisma } from '../lib/db';

const uuid = '123e4567-e89b-12d3-a456-426614174000';

test('legacyId resolves to conversation uuid on page', async ({ page }) => {
  await prisma.conversation_aliases.upsert({
    where: { legacy_id: 456 },
    create: { legacy_id: 456, uuid },
    update: { uuid },
  });
  await page.goto('http://127.0.0.1:3000/dashboard/guest-experience/cs?legacyId=456');
  await expect(page).toHaveURL(/conversation=123e4567-e89b-12d3-a456-426614174000/);
});
