import { test, expect } from '@playwright/test';
import next from 'next';
import http from 'http';

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

test('legacy shortlink redirects and preserves query', async ({ page }) => {
  const { server, port } = await startServer();
  await page.goto(`http://localhost:${port}/r/conversation/abc123?from=email`, { waitUntil: 'domcontentloaded' });
  const u = new URL(page.url());
  expect(u.pathname).toBe('/dashboard/guest-experience/all');
  expect(u.searchParams.get('conversation')).toBe('abc123');
  expect(u.searchParams.get('from')).toBe('email');
  await stopServer(server);
});

test('deep-link renders without runtime TypeError', async ({ page }) => {
  const { server, port } = await startServer();
  await page.goto(
    `http://localhost:${port}/dashboard/guest-experience/all?conversation=test-123`,
    { waitUntil: 'domcontentloaded' },
  );
  await expect(page.getByText(/TypeError: undefined is not an object/i)).toHaveCount(0);
  await expect(page).toHaveURL(/\/dashboard\/guest-experience\/all/);
  await stopServer(server);
});
