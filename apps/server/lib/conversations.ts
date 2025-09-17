/*
 * TypeScript bridge that re-exports the robust JS implementation.
 * This prevents accidental use of a stub and guarantees consistent behavior
 * across TS/JS call-sites.
 */
export type ResolveOpts = {
  inlineThread?: unknown;
  fetchFirstMessage?: (idOrSlug: string) => Promise<unknown> | unknown;
  skipRedirectProbe?: boolean;
  onDebug?: (d: unknown) => void;
};

// Runtime implementation (DB lookups, alias mining, redirect/message probes)
// lives in the JS file and is shared by Node scripts and Next runtime.
export { tryResolveConversationUuid } from './conversations.js';
