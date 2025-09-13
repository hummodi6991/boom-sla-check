# Conversation UUID Migration

All alert-producing services must emit a `conversation_uuid` field containing the v4 UUID of the conversation.
Numeric identifiers and slug-based lookups are no longer supported.

Steps for producers:

1. Look up the conversation UUID at the time the event is created.
2. Populate `conversation_uuid` on every event.
3. Remove legacy numeric IDs from payloads.

Rotate and store the `LINK_SECRET` used for deep-link tokens in your secrets manager before deploying.
