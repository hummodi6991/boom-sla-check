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

#License:

