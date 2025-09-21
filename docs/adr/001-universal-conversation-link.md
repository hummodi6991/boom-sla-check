# ADR 001: Universal conversation deep link

## Status

Accepted – implemented in `fix/universal-conversation-deeplink`.

## Context

SLA alerts and a variety of legacy routes deep-linked agents straight to
`/dashboard/guest-experience/all?conversation=<token>`. The token could be a
UUID, a numeric legacy identifier, or a slug. On WebKit/Safari the guest
experience page occasionally loaded before the conversation record resolved,
triggering `TypeError: undefined is not an object (evaluating 's.related_reservations')`
while the UI attempted to hydrate related reservations. We also saw alert emails
break when a link pointed at an identifier that required a DB lookup because the
SPA booted without the conversation list preloaded.

## Decision

* Introduced a universal redirect entry point at `/go/c/:token`.
  * `:token` accepts UUIDs, numeric ids and slugs.
  * The handler asks the hedged resolver for the canonical UUID (no mint
    fallback). When successful it issues a `302` redirect to the canonical view
    (`/dashboard/guest-experience/all?conversation=<uuid>`). When resolution
    fails it serves a small HTML page explaining that the conversation could not
    be found and links back to the guest experience dashboard.
  * `resolveConversationToken` is exported for reuse in tests and helper
    servers.
* Hardened the guest experience client to tolerate undefined conversation data
  by guarding related reservation access with optional chaining and a default
  array before kicking off drawer side-effects.
* Updated every link builder used by alerts and redirectors to emit
  `https://app.boomnow.com/go/c/<token>` instead of the brittle query-string
  form. Legacy routes (`/dashboard/guest-experience/all?conversation=...`) still
  work for backwards compatibility, but new links all flow through the redirect
  entry point.
* Added Playwright coverage for `/go/c/<uuid>`, `/go/c/<legacy-id>`, and
  `/go/c/<slug>` plus unit tests for the token resolver and the UI guard.

## Consequences

* Alert emails and cron notifications now produce stable conversation links that
  Safari can open reliably. The guard ensures the guest experience surface never
  dereferences `related_reservations` before data arrives.
* The redirector and cron scripts rely on the shared `makeConversationLink`
  helper, so any future identifier paths will naturally adopt the universal
  route.
* Environment expectations remain unchanged: the resolver still honours
  `RESOLVE_SECRET`, `RESOLVE_BASE_URL`, `APP_URL`, and associated hedging
  settings. Operators need no additional configuration beyond ensuring the
  existing resolver credentials work in the `/go/c/:token` handler.
