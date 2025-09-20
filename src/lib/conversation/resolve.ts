import type { ResolveOpts } from '../../../apps/server/lib/conversations';
import {
  conversationDeepLink as coreConversationDeepLink,
  conversationUuidNamespace,
  mintUuidFromLegacyId as coreMintUuidFromLegacyId,
  mintUuidFromRaw as coreMintUuidFromRaw,
  mintUuidFromSlug as coreMintUuidFromSlug,
  resolveConversationUuid as coreResolveConversationUuid,
  CONVERSATION_UUID_NAMESPACE_DEFAULT,
} from '../../../lib/conversationResolveCore.js';

export type ResolveConversationOptions = ResolveOpts & {
  allowMintFallback?: boolean;
};

export type ResolvedConversation = {
  uuid: string;
  minted: boolean;
};

export async function resolveConversationUuid(
  raw: string,
  opts: ResolveConversationOptions = {},
): Promise<ResolvedConversation | null> {
  const { allowMintFallback, ...rest } = opts;
  return coreResolveConversationUuid(raw, {
    ...(rest as ResolveOpts),
    allowMintFallback,
  });
}

export function conversationDeepLink(uuid: string, base?: string): string {
  return coreConversationDeepLink(uuid, base);
}

export function mintUuidFromLegacyId(legacyId: number): string {
  return coreMintUuidFromLegacyId(legacyId);
}

export function mintUuidFromSlug(slug: string): string {
  return coreMintUuidFromSlug(slug);
}

export function mintUuidFromRaw(raw: string): string | null {
  return coreMintUuidFromRaw(raw);
}

export { conversationUuidNamespace, CONVERSATION_UUID_NAMESPACE_DEFAULT };
