import { tryResolveConversationUuid } from '../../server/lib/conversations.js';
import { resolveViaInternalEndpoint } from '../../../lib/internalResolve.js';
import { mintUuidFromRaw, isUuid } from './canonicalConversationUuid.js';

export async function resolveConversationUuid(idOrSlug, opts = {}) {
  const raw = String(idOrSlug ?? '').trim();
  if (!raw) return null;
  try {
    const maybe = await tryResolveConversationUuid(raw, opts);
    if (maybe) return maybe.toLowerCase();
  } catch {}
  try {
    const viaInternal = await resolveViaInternalEndpoint(raw);
    if (viaInternal) return viaInternal.toLowerCase();
  } catch {
    // fall through to minting
  }
  // ULC-v2: do not mint when the raw value is already a UUID; that produces broken links.
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
