## Order Count API

A minimal serverless endpoint that returns the total number of customer purchases (orders) from a Shopify store.

### API

- Route: `api/total-orders.ts`
- Response:
  - `{ totalOrders: number, precision?: "EXACT"|"LOW"|"HIGH" }`

### Environment variables

Create a `.env` with:

- `SHOPIFY_DOMAIN` (e.g. `your-store.myshopify.com`)
- `SHOPIFY_ADMIN_API_ACCESS_TOKEN` (private app token)

The endpoint also supports the legacy `SHOPIFY_TOKEN` name.

### Local run

This is designed for Vercel serverless. You can deploy directly without a build step.

### Deploy to Vercel (via GitHub)

1. Push this repo to GitHub.
2. In Vercel, import the project from GitHub.
3. Set Environment Variables (Production):
   - `SHOPIFY_DOMAIN`
   - `SHOPIFY_ADMIN_API_ACCESS_TOKEN`
4. Deploy.

### Notes

- Uses Shopify Admin GraphQL `ordersCount` as the primary, with deprecated REST `orders/count.json` as a fallback.
- API version is pinned to `2025-07`.
