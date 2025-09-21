import { resolveConversation } from '../../../packages/linking/src/index.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

export async function resolveConversationUuid(idOrSlug, opts = {}) {
  const raw = String(idOrSlug ?? '').trim();
  if (!raw) return null;
  const input = { allowMintFallback: opts.allowMintFallback };
  if (UUID_RE.test(raw)) {
    input.uuid = raw;
  } else if (/^\d+$/.test(raw)) {
    input.legacyId = raw;
  } else {
    input.slug = raw;
  }
  if (opts.inlineThread) input.inlineThread = opts.inlineThread;
  if (opts.fetchFirstMessage) input.fetchFirstMessage = opts.fetchFirstMessage;
  if (opts.skipRedirectProbe) input.skipRedirectProbe = opts.skipRedirectProbe;
  if (opts.onDebug) input.onDebug = opts.onDebug;
  const resolved = await resolveConversation(input);
  return resolved?.uuid ?? null;
}
