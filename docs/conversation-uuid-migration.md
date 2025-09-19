# Conversation UUID Migration

All alert-producing services must emit a `conversation_uuid` field containing the UUID of the conversation.
Numeric identifiers and slug-based lookups are no longer supported for **new** producers.

**Operational fallback:**  
If a legacy producer still emits only a numeric ID/slug and no UUID can be resolved from DB/aliases/probes,
the system will **mint a deterministic UUIDv5** based on `APP_URL` + `BOOM_ORG_ID` and the identifier. This
guarantees alerts can still carry a verified, deep-linkable UUID while we complete upstream migration.
If/when a real UUID later becomes available for the same legacy ID, the alias table is updated to prefer the real one.

Steps for producers:

1. Look up the conversation UUID at the time the event is created.
2. Populate `conversation_uuid` on every event.
3. Remove legacy numeric IDs from payloads.

Rotate and store the `LINK_SECRET` used for deep-link tokens in your secrets manager before deploying.
