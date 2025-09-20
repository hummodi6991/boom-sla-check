import { tryResolveConversationUuid } from '../../server/lib/conversations.js';
import {
  resolveViaInternalEndpoint,
  resolveViaPublicEndpoint,
} from '../../../lib/internalResolve.js';
import { mintUuidFromRaw, isUuid } from './canonicalConversationUuid.js';

export type ResolveConversationOpts = {
  inlineThread?: unknown;
  fetchFirstMessage?: (idOrSlug: string) => Promise<unknown> | unknown;
  skipRedirectProbe?: boolean;
  onDebug?: (d: unknown) => void;
  allowMintFallback?: boolean;
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
    if (viaInternal) return viaInternal.toLowerCase();
  } catch {
    // fall through to public resolver / minting
  }
  try {
    const viaPublic = await resolveViaPublicEndpoint(raw);
    if (viaPublic) return viaPublic.toLowerCase();
  } catch {
    // fall through to minting
  }
  // ULC-v2: do not mint when the raw value is already a UUID.
  if (opts.allowMintFallback !== false && !isUuid(raw)) {
    try {
      const minted = mintUuidFromRaw(raw);
      return minted ? minted.toLowerCase() : null;
    } catch {
      return null;
    }
  }
  return null;
}
