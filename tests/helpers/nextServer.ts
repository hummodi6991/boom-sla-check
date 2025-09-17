import http from 'http';
import { verifyLinkToken } from '../../apps/shared/lib/linkToken';
import { conversationDeepLinkFromUuid, appUrlFromRequest } from '../../apps/shared/lib/links';
import { metrics } from '../../lib/metrics';

type StartedServer = { server: http.Server; port: number };

const previousAppUrl = new WeakMap<http.Server, string | undefined>();

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

const HTML = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Conversation</title>
    <style>
      body { font-family: sans-serif; margin: 16px; }
    </style>
  </head>
  <body>
    <div id="status"></div>
    <div data-uuid="">Conversation </div>
    <script>
      (() => {
        const init = () => {
          const statusEl = document.getElementById('status');
          const holder = document.querySelector('[data-uuid]');
          const setUuid = (value) => {
            if (!holder) return;
            holder.setAttribute('data-uuid', value || '');
            holder.textContent = value ? 'Conversation ' + value : 'Conversation ';
          };
          const params = new URLSearchParams(window.location.search);
          const convo = params.get('conversation');
          const legacyId = params.get('legacyId');
          if (convo && ${UUID_RE}.test(convo)) {
            setUuid(convo.toLowerCase());
            return;
          }
          if (legacyId && /^\\d+$/.test(legacyId)) {
            fetch('/api/resolve/conversation?legacyId=' + encodeURIComponent(legacyId), { credentials: 'include' })
              .then((res) => (res.ok ? res.json() : null))
              .then((data) => {
                const uuid = data && data.uuid;
                if (uuid && ${UUID_RE}.test(uuid)) {
                  const lower = uuid.toLowerCase();
                  setUuid(lower);
                  const sp = new URLSearchParams(window.location.search);
                  sp.delete('legacyId');
                  sp.set('conversation', lower);
                  window.history.replaceState({}, '', window.location.pathname + '?' + sp.toString());
                } else if (statusEl) {
                  statusEl.textContent = 'Conversation not found or has been deleted.';
                }
              })
              .catch(() => {
                if (statusEl) statusEl.textContent = 'Conversation not found or has been deleted.';
              });
          }
        };
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', init, { once: true });
        } else {
          init();
        }
      })();
    </script>
  </body>
</html>`;

export async function startTestServer(): Promise<StartedServer> {
  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const requestUrl = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && requestUrl.pathname.startsWith('/r/t/')) {
      const token = requestUrl.pathname.split('/')[3];
      if (!token) {
        res.statusCode = 400;
        res.end('invalid token');
        return;
      }
      try {
        const result = verifyLinkToken(token);
        if ('error' in result) {
          metrics.increment(`link_token.${result.error}`);
          res.statusCode = 400;
          res.end('invalid token');
          return;
        }
        const baseUrl = appUrlFromRequest({ url: requestUrl.toString() });
        const location = conversationDeepLinkFromUuid(result.uuid, { baseUrl });
        res.statusCode = 302;
        res.setHeader('Location', location);
        res.end();
      } catch {
        res.statusCode = 500;
        res.end('invalid token');
      }
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/dashboard/guest-experience/all') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(HTML);
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname.startsWith('/_next/')) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });
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
