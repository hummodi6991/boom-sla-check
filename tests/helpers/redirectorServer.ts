import http from 'http';
import { createRedirectorApp } from '../../apps/redirector/app.js';

export type RedirectorHandle = {
  server: http.Server;
  port: number;
};

export async function startRedirectorServer(): Promise<RedirectorHandle> {
  const app = createRedirectorApp();
  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end('bad request');
      return;
    }
    const origin = `http://${req.headers.host || 'localhost'}`;
    const request = new Request(new URL(req.url, origin), {
      method: req.method,
      headers: req.headers as any,
    });
    const response = await app.fetch(request);
    res.statusCode = response.status;
    for (const [key, value] of response.headers) {
      res.setHeader(key, value);
    }
    if (response.body) {
      const buffer = Buffer.from(await response.arrayBuffer());
      res.end(buffer);
    } else {
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, port };
}

export async function stopRedirectorServer(handle: RedirectorHandle) {
  await new Promise<void>((resolve) => handle.server.close(() => resolve()));
}
