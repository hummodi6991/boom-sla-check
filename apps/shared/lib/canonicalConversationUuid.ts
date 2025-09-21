import {
  CONVERSATION_UUID_NAMESPACE_DEFAULT,
  mintUuidFromLegacyId as jsMintUuidFromLegacyId,
  mintUuidFromSlug as jsMintUuidFromSlug,
  mintUuidFromRaw as jsMintUuidFromRaw,
  isUuid as jsIsUuid,
  conversationUuidNamespace,
} from '../../../packages/conversation-uuid/index.js';

export const CONV_UUID_NAMESPACE_FALLBACK = CONVERSATION_UUID_NAMESPACE_DEFAULT;

export function mintUuidFromLegacyId(legacyId: number): string {
  return jsMintUuidFromLegacyId(legacyId);
}

export function mintUuidFromSlug(slug: string): string {
  return jsMintUuidFromSlug(slug);
}

export function mintUuidFromRaw(raw: string): string | null {
  return jsMintUuidFromRaw(raw);
}

export function isUuid(v: string): boolean {
  return jsIsUuid(v);
}

export function conversationNamespace(): string {
  return conversationUuidNamespace();
}
