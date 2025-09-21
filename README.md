# boom-sla-check

Boom's SLA monitor ingests guest conversations, identifies unanswered threads, and emits signed alert links that resolve safely through the redirector. The project also hosts lightweight dashboard routes used by deep links in email and support tooling.

## Installation

```bash
npm install
```

## Testing

```bash
npm test
```

## Environment configuration

### Core Boom credentials & URLs

Set the following variables so the check and cron runners can authenticate against the Boom app:

- `APP_URL` – canonical application host (defaults to `https://app.boomnow.com`).
- `BOOM_USER` / `BOOM_PASS` – login credentials used when cookies or bearer tokens are unavailable.
- `BOOM_COOKIE` – optional pre-authenticated cookie header for direct API access.
- `BOOM_TOKEN` / `BOOM_BEARER` – optional bearer tokens used to call Boom APIs.
- `BOOM_API_BASE` – REST API base URL used by helper scripts (for example `https://api.boomnow.com`).
- `BOOM_API_TOKEN` – API token used with `BOOM_API_BASE`.
- `BOOM_ORG_ID` – organisation/account scope applied to API calls.
- `LOGIN_URL`, `LOGIN_METHOD`, `LOGIN_CT`, `LOGIN_EMAIL_FIELD`, `LOGIN_PASSWORD_FIELD`, `LOGIN_TENANT_FIELD` – customise interactive login when the job needs to bootstrap a session.
- `CONVERSATIONS_URL` – API endpoint that lists conversations for the cron sweep.
- `MESSAGES_URL` – API endpoint template for fetching a conversation thread. Include `{{conversationId}}` so the scripts can substitute the lookup identifier, for example `https://app.boomnow.com/api/conversations/{{conversationId}}/messages`.

### Conversation list & selection controls

- `LIST_LIMIT_PARAM` – query parameter that controls page size when fetching the conversations list.
- `LIST_OFFSET_PARAM` – query parameter that controls pagination (`offset`, `page`, etc.).
- `PAGE_SIZE` – expected page size (defaults to `30`).
- `CHECK_LIMIT` – hard cap on the number of conversations the cron job evaluates per run.

> The cron sweep always requests the first two pages (~30 items per page) and deduplicates results before selecting the objectively newest window of conversations.

### Alert links and redirector

- `ALERT_LINK_BASE` – host that serves signed redirector links (for example `https://go.boomnow.com`).
- `TARGET_APP_URL` – Boom app base URL used by the redirector when building deep links.
- `LINK_PRIVATE_JWK` – Ed25519 private key (JWK format) used to sign alert tokens.
- `LINK_PUBLIC_JWKS` – JWKS bundle containing the corresponding public keys. The redirector caches this JWKS for 60 seconds.
- `LINK_KID` – key identifier embedded in signed tokens.
- `LINK_ISSUER` / `LINK_AUDIENCE` – issuer and audience claims enforced by the redirector when verifying tokens.

### Conversation UUID namespace

- `CONVERSATION_UUID_NAMESPACE` – UUID namespace used for deterministic UUIDv5 minting when a legacy id or slug needs a stable fallback. Defaults to `3f3aa693-5b5d-4f6a-9c8e-7b7a1d1d8b7a`.

### Internal resolution

- `RESOLVE_BASE_URL` – Boom app host that exposes `/api/internal/resolve-conversation` for HMAC-authenticated lookups.
- `RESOLVE_SECRET` – shared secret used to sign internal resolve requests.

These settings allow the jobs to resolve canonical UUIDs, construct verified deep links, and mail operators without exposing raw identifiers.

## Redirector behaviour

The stateless redirector (`apps/redirector`) verifies Ed25519 tokens against `LINK_PUBLIC_JWKS`, unwraps nested redirect parameters, and forwards users with `303 See Other` responses. Invalid or expired tokens fall back to `/link/help`; if a legacy conversation id is present, the redirector sends users to `/dashboard/guest-experience/all?legacyId=<id>` instead of the legacy CS route.

