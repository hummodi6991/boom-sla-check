import { test, expect } from '@playwright/test';
import next from 'next';
import http from 'http';
import { prisma } from '../lib/db';

async function startServer() {
  const app = next({ dev: true, dir: process.cwd() });
  const handle = app.getRequestHandler();
  await app.prepare();
  const server = http.createServer((req, res) => handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  return { server, port };
}

async function stopServer(server: http.Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const uuid = '123e4567-e89b-12d3-a456-426614174000';

test('legacyId resolves to conversation uuid on page', async ({ page }) => {
  const { server, port } = await startServer();
  await prisma.conversation_aliases.upsert({
    where: { legacy_id: 456 },
    create: { legacy_id: 456, uuid },
    update: { uuid },
  });
  await page.goto(`http://localhost:${port}/dashboard/guest-experience/cs?legacyId=456`);
  await expect(page).toHaveURL(/conversation=123e4567-e89b-12d3-a456-426614174000/);
  await stopServer(server);
});
