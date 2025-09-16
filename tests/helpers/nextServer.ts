import next from 'next';
import http from 'http';

type StartedServer = { server: http.Server; port: number };

const previousAppUrl = new WeakMap<http.Server, string | undefined>();

export async function startTestServer(): Promise<StartedServer> {
  process.env.NEXT_DISABLE_VERSION_CHECK = '1';
  process.env.NEXT_TELEMETRY_DISABLED = '1';
  const app = next({ dev: true, dir: process.cwd() });
  const handle = app.getRequestHandler();
  await app.prepare();
  const server = http.createServer((req, res) => handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port as number;
  previousAppUrl.set(server, process.env.APP_URL);
  process.env.APP_URL = `http://localhost:${port}`;
  return { server, port };
}

export async function stopTestServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const prev = previousAppUrl.get(server);
  if (prev !== undefined) {
    process.env.APP_URL = prev;
  } else {
    delete process.env.APP_URL;
  }
  previousAppUrl.delete(server);
}
