import { test, expect } from '@playwright/test';
import { startTestServer, stopTestServer } from './helpers/nextServer';
import { prisma } from '../lib/db';

const uuid = '123e4567-e89b-12d3-a456-426614174000';

test('legacyId resolves to conversation uuid on page', async ({ page }) => {
  const { server, port } = await startTestServer();
  await prisma.conversation_aliases.upsert({
    where: { legacy_id: 456 },
    create: { legacy_id: 456, uuid },
    update: { uuid },
  });
  await page.goto(`http://localhost:${port}/dashboard/guest-experience/cs?legacyId=456`);
  await expect(page).toHaveURL(/conversation=123e4567-e89b-12d3-a456-426614174000/);
  await stopTestServer(server);
});
