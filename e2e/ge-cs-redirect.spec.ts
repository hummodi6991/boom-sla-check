import { test, expect } from '@playwright/test';
import next from 'next';
import http from 'http';

// Start a Next.js server for testing the redirect.
async function startServer() {
  const app = next({ dev: true, dir: process.cwd() });
  const handle = app.getRequestHandler();
  await app.prepare();
  const server = http.createServer((req, res) => handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  return { server, port };
}

// Ensure the server is closed after the test.
async function stopServer(server: http.Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test('legacy /cs route redirects to /all and preserves query', async ({ page }) => {
  const { server, port } = await startServer();
  const q = 'conversation=test-123';
  await page.goto(`http://localhost:${port}/dashboard/guest-experience/cs?${q}`, {
    waitUntil: 'domcontentloaded',
  });

  const url = new URL(page.url());
  expect(url.pathname).toBe('/dashboard/guest-experience/all');
  expect(url.searchParams.get('conversation')).toBe('test-123');

  await stopServer(server);
});
