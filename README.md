# Name
### boom-sla-check

# Synopsis


# Description

# Example

# Install:
`npm install boom-sla-check`

# Test:
`npm test`

## Environment Variables

- `BOOM_API_BASE` – base URL for Boom API
- `BOOM_API_TOKEN` – API token for authentication
- `BOOM_ORG_ID` – organization/account identifier
- `(Optional) CHECK_BATCH_SIZE` – batch size for downstream processing
- `LIST_LIMIT_PARAM` – name of the query parameter controlling page size when listing conversations
- `LIST_OFFSET_PARAM` – name of the query parameter controlling list offset or page number
- `PAGE_SIZE` – number of conversations per page (defaults to 30)
The cron job now fetches the first two pages of the conversations list (≈30 per page), supporting both limit/offset and page-based APIs.

## Email Links: Architecture, JWKS, and Redirector

Alert emails now ship with a hardened redirect flow. The mailer signs a short-lived Ed25519 JWT that encodes the target conversation identifiers, and the lightweight redirector app (see `apps/redirector`) validates the token before forwarding the user to the canonical dashboard URL.

```
mailer ──signLink()──▶ go.boomnow.com/u/<jwt> ──verifyLink() + resolveConversation()──▶ https://app.boomnow.com/dashboard/guest-experience/all?conversation=<uuid>
```

Key properties:

- **Ed25519 tokens** – Links are signed with `LINK_PRIVATE_JWK` and verified against the rotate-ready JWKS served from `/.well-known/jwks.json`.
- **Stateless redirector** – The Hono-based redirector honours both `GET` and `HEAD` requests, always answers with `303 See Other`, and sets `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and `X-Robots-Tag: noindex, nosnippet`.
- **Conversation resolution** – Incoming tokens and `/c/:raw` lookups are normalised via `packages/linking`, which prefers in-memory/DB hits and falls back to the public resolver before minting.
- **Safe-link resilience** – The redirector unwraps nested `?url=` parameters and double-encoded paths to survive external redirectors.
- **Fallback UX** – Expired or tampered tokens drop users on `/link/help`, a static landing page with retry instructions. When a legacy ID is present we still forward to `/dashboard/guest-experience/cs?legacyId=<id>`.

Production guardrails:

- Production **must** set `REQUIRE_SIGNED_ALERT_LINKS=1` so the mailer refuses to emit raw deep links.
- If you ever see deep links in email HTML, double-check `LINK_PRIVATE_JWK` and `ALERT_LINK_BASE` on the worker deployment.
- Optional: allow-list `go.boomnow.com` (or your custom `ALERT_LINK_BASE`) in Microsoft Safe Links to keep tokens intact.

### Operations cheatsheet

- Populate the following env vars (see `.env.example`):
  - `ALERT_LINK_BASE` (e.g. `https://go.boomnow.com`)
  - `TARGET_APP_URL` (e.g. `https://app.boomnow.com`)
  - `LINK_PRIVATE_JWK`, `LINK_PUBLIC_JWKS`, `LINK_KID`, `LINK_ISSUER`, `LINK_AUDIENCE`
- Rotate keys by appending the new JWK to `LINK_PUBLIC_JWKS`, deploying the redirector, then updating the mailer `LINK_PRIVATE_JWK` and `LINK_KID`.
- Local development: `pnpm dev:redirector` runs the redirector on port `3005` (use `pnpm deploy:redirector` for production parity).
- Existing `/r/*` Next.js routes remain available for local debugging, but new outbound mail links should point at `https://go.boomnow.com/u/<jwt>` immediately.
- For back-compat on the main app host, issue a temporary `308` from `app.boomnow.com/r/*` to `go.boomnow.com/c/*` until old links age out.

#License:

