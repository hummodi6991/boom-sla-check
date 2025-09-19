import { tryResolveConversationUuid } from '../../server/lib/conversations.js';
import { resolveViaInternalEndpoint } from '../../../lib/internalResolve.js';
import { mintUuidFromRaw } from './canonicalConversationUuid.js';

export async function resolveConversationUuid(idOrSlug, opts = {}) {
  const raw = String(idOrSlug ?? '').trim();
  if (!raw) return null;
  try {
    const maybe = await tryResolveConversationUuid(raw, opts);
    if (maybe) return maybe.toLowerCase();
  } catch {}
  try {
    const viaInternal = await resolveViaInternalEndpoint(raw);
    return viaInternal ? viaInternal.toLowerCase() : null;
  } catch {
    // fall through to minting
  }
  try {
    const minted = mintUuidFromRaw(raw);
    return minted ? minted.toLowerCase() : null;
  } catch {
    return null;
  }
}
