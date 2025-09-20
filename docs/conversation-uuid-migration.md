# Conversation UUID Migration

All alert-producing services must emit a `conversation_uuid` field containing the UUID of the conversation.
Numeric identifiers and slug-based lookups are no longer supported for **new** producers.

**Operational fallback:**
If a legacy producer still emits only a numeric ID/slug and no UUID can be resolved from DB/aliases/probes,
the system will **mint a deterministic UUIDv5** by hashing the identifier inside the
`CONVERSATION_UUID_NAMESPACE` (configurable via environment variable). The mint uses the prefix
`legacy:` for numeric identifiers and `slug:` for string identifiers. This guarantees alerts can still carry a
verified, deep-linkable UUID while we complete upstream migration. If/when a real UUID later becomes
available for the same legacy ID, the alias table is updated to prefer the real one.

Steps for producers:

1. Look up the conversation UUID at the time the event is created.
2. Populate `conversation_uuid` on every event.
3. Remove legacy numeric IDs from payloads.

## Magic link signing keys

Alert emails now use asymmetric RS256 link tokens. Provision a key pair and configure:

- `LINK_PRIVATE_KEY_PEM` (PKCS#8 private key)
- Either `LINK_PUBLIC_KEY_PEM` (SPKI) **or** `LINK_JWKS_URL` pointing at the published JWKS endpoint
- `LINK_SIGNING_KID` identifying the active key

Rotate the private key using your secrets manager and deploy the matching public key (or JWKS) so
consumers can verify the links. Tokens expire after ~15 minutes; optionally provide `REDIS_URL` to enforce
single-use semantics via the cache.
