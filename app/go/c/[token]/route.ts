import { NextResponse } from 'next/server.js';
import { resolveConversationUuid } from '../../../../apps/shared/lib/conversationUuid.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CACHE_CONTROL = 'no-store';

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function canonicalConversationUrl(req: Request, uuid: string) {
  const origin = new URL(req.url);
  const dest = new URL('/dashboard/guest-experience/all', origin.origin);
  dest.searchParams.set('conversation', uuid);
  return dest.toString();
}

function notFoundHtml(token: string | null) {
  const advice = token
    ? `<p>The conversation link <code>${escapeHtml(token)}</code> could not be resolved. It may have expired, been deleted, or you might not have permission to view it.</p>`
    : '<p>The conversation link could not be resolved. It may have expired, been deleted, or you might not have permission to view it.</p>';
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Conversation not found</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 0; background: #f9fafb; color: #111827; }
      main { max-width: 480px; margin: 40px auto; background: #fff; border-radius: 12px; padding: 32px; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08); }
      h1 { font-size: 1.5rem; margin-bottom: 16px; }
      p { line-height: 1.6; margin: 12px 0; }
      a { color: #2563eb; text-decoration: none; }
      a:hover { text-decoration: underline; }
      code { background: #f3f4f6; border-radius: 4px; padding: 2px 4px; font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; }
    </style>
  </head>
  <body>
    <main>
      <h1>Conversation not found</h1>
      ${advice}
      <p><a href="/dashboard/guest-experience/all">Return to Guest Experience</a></p>
    </main>
  </body>
</html>`;
}

function buildNotFoundResponse(token: string | null, includeBody: boolean) {
  const headers = new Headers({ 'Cache-Control': CACHE_CONTROL });
  if (includeBody) {
    headers.set('Content-Type', 'text/html; charset=utf-8');
    return new NextResponse(notFoundHtml(token), { status: 404, headers });
  }
  return new NextResponse(null, { status: 404, headers });
}

export async function resolveConversationToken(token: string | null | undefined) {
  const raw = typeof token === 'string' ? token.trim() : '';
  if (!raw) return null;
  if (UUID_RE.test(raw)) {
    return raw.toLowerCase();
  }
  try {
    const uuid = await resolveConversationUuid(raw, {
      allowMintFallback: false,
      // Enable redirect probe so legacy ids / slugs succeed even when the
      // internal resolver or alias cache is unavailable.
      skipRedirectProbe: false,
    });
    if (uuid && UUID_RE.test(uuid)) {
      return uuid.toLowerCase();
    }
  } catch {
    // ignore resolver failures; fall through to return null
  }
  return null;
}

async function handleConversationRedirect(
  req: Request,
  token: string | null,
  includeBody: boolean,
) {
  const resolved = await resolveConversationToken(token);
  if (resolved) {
    const location = canonicalConversationUrl(req, resolved);
    const headers = new Headers({ 'Cache-Control': CACHE_CONTROL });
    headers.set('Location', location);
    return new NextResponse(null, { status: 302, headers });
  }
  return buildNotFoundResponse(token, includeBody);
}

export async function GET(req: Request, { params }: { params: { token?: string } }) {
  return handleConversationRedirect(req, params?.token ?? null, true);
}

export async function HEAD(req: Request, { params }: { params: { token?: string } }) {
  return handleConversationRedirect(req, params?.token ?? null, false);
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
