import { tryResolveConversationUuid } from '../../server/lib/conversations.js';
import { resolveViaInternalEndpoint } from '../../../lib/internalResolve.js';

export type ResolveConversationOpts = {
  inlineThread?: unknown;
  fetchFirstMessage?: (idOrSlug: string) => Promise<unknown> | unknown;
  skipRedirectProbe?: boolean;
  onDebug?: (d: unknown) => void;
};

export async function resolveConversationUuid(
  idOrSlug: string,
  opts: ResolveConversationOpts = {}
): Promise<string | null> {
  const raw = String(idOrSlug ?? '').trim();
  if (!raw) return null;
  try {
    const maybe = await tryResolveConversationUuid(raw, opts as any);
    if (maybe) return maybe.toLowerCase();
  } catch {}
  try {
    const viaInternal = await resolveViaInternalEndpoint(raw);
    return viaInternal ? viaInternal.toLowerCase() : null;
  } catch {
    return null;
  }
}
