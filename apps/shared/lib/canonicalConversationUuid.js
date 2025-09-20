import {
  CONVERSATION_UUID_NAMESPACE_DEFAULT,
  conversationUuidNamespace,
  isUuid as coreIsUuid,
  mintUuidFromLegacyId as coreMintUuidFromLegacyId,
  mintUuidFromRaw as coreMintUuidFromRaw,
  mintUuidFromSlug as coreMintUuidFromSlug,
} from '../../../lib/conversationResolveCore.js';

export const CONV_UUID_NAMESPACE_FALLBACK = CONVERSATION_UUID_NAMESPACE_DEFAULT;

export function mintUuidFromLegacyId(legacyId) {
  return coreMintUuidFromLegacyId(legacyId);
}

export function mintUuidFromSlug(slug) {
  return coreMintUuidFromSlug(slug);
}

export function mintUuidFromRaw(raw) {
  return coreMintUuidFromRaw(raw);
}

export function isUuid(v) {
  return coreIsUuid(v);
}

export function conversationNamespace() {
  return conversationUuidNamespace();
}
