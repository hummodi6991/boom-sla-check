import {
  resolveConversationUuidHedged as jsResolveConversationUuidHedged,
  resolveConversationUuid as jsResolveConversationUuid,
  hedgedTest as jsTest,
} from '../../../packages/conversation-uuid/index.js';

export type ResolveConversationOpts = {
  inlineThread?: unknown;
  fetchFirstMessage?: (idOrSlug: string) => Promise<unknown> | unknown;
  skipRedirectProbe?: boolean;
  onDebug?: (d: unknown) => void;
  allowMintFallback?: boolean;
};

export function resolveConversationUuidHedged(
  idOrSlug: string,
  opts: ResolveConversationOpts = {},
): Promise<string | null> {
  return jsResolveConversationUuidHedged(idOrSlug, opts);
}

export function resolveConversationUuid(
  idOrSlug: string,
  opts: ResolveConversationOpts = {},
): Promise<string | null> {
  return jsResolveConversationUuid(idOrSlug, opts);
}

export const __test__ = jsTest;
