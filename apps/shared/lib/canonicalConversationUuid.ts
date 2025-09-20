import {
  CONVERSATION_UUID_NAMESPACE_DEFAULT,
  conversationUuidNamespace,
  isUuid as coreIsUuid,
  mintUuidFromLegacyId as coreMintUuidFromLegacyId,
  mintUuidFromRaw as coreMintUuidFromRaw,
  mintUuidFromSlug as coreMintUuidFromSlug,
} from '../../../lib/conversationResolveCore.js';

export const CONV_UUID_NAMESPACE_FALLBACK = CONVERSATION_UUID_NAMESPACE_DEFAULT;

export function mintUuidFromLegacyId(legacyId: number): string {
  return coreMintUuidFromLegacyId(legacyId);
}

export function mintUuidFromSlug(slug: string): string {
  return coreMintUuidFromSlug(slug);
}

export function mintUuidFromRaw(raw: string): string | null {
  return coreMintUuidFromRaw(raw);
}

export function isUuid(v: string): boolean {
  return coreIsUuid(v);
}

export function conversationNamespace(): string {
  return conversationUuidNamespace();
}
