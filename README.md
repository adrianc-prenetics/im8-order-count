## Order Count API

A minimal serverless endpoint that returns the exact number of customer purchases (orders) from a Shopify store using GraphQL Bulk Operations.

### API

- Route: `api/exact-order-count.ts`
- Query params:
  - `wait=1` to wait for completion (default 0)
  - `timeoutMs=30000` max 30000
  - `query=` optional Admin search syntax filter
  - `maxAgeMinutes=60` reuse last completed bulk result if newer than this
  - `minStartIntervalMs=60000` minimum time between starting new bulk jobs (protects limits)
  - `force=1` ignore cache and start a new bulk operation
- Response (wait=1 and completed):
  - `{ status: "COMPLETED", exactOrders: number }`
  - otherwise: `{ status, objectCount?, message? }` while running

### Environment variables

Create a `.env` with:

- `SHOPIFY_DOMAIN` (e.g. `your-store.myshopify.com`)
- `SHOPIFY_ADMIN_API_ACCESS_TOKEN` (private app token)

The endpoint also supports the legacy `SHOPIFY_TOKEN` name.

### Notes

- API version is pinned to `2025-07`.
- Endpoint sets `Cache-Control: s-maxage=5, stale-while-revalidate=30` to absorb spikes at the edge.
- Uses in-memory de-dupe and a start rate limiter to avoid exceeding Shopify limits under heavy traffic.
