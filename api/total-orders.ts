import { createAdminApiClient } from '@shopify/admin-api-client';

// Support both SHOPIFY_ADMIN_API_ACCESS_TOKEN and legacy SHOPIFY_TOKEN
const accessToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN || process.env.SHOPIFY_TOKEN;
const storeDomain = process.env.SHOPIFY_DOMAIN;

const client = createAdminApiClient({
	storeDomain: storeDomain!,
	accessToken: accessToken!,
	apiVersion: '2025-07',
});

export default async function handler(req: any, res: any) {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

	if (req.method === 'OPTIONS') {
		res.status(200).end();
		return;
	}

	if (!storeDomain || !accessToken) {
		res.status(500).json({ error: 'Missing SHOPIFY_DOMAIN or SHOPIFY_ADMIN_API_ACCESS_TOKEN' });
		return;
	}

	// Optional filter via querystring, e.g. ?query=financial_status:paid
	const queryFilter = typeof req?.query?.query === 'string' ? req.query.query : undefined;

	try {
		const graphQuery = `
			query OrdersCount($query: String) {
				ordersCount(query: $query) {
					count
					precision
				}
			}
		`;
		const { data } = await client.request(graphQuery, { variables: { query: queryFilter } });
		res.status(200).json({ totalOrders: data.ordersCount.count, precision: data.ordersCount.precision });
	} catch (err: any) {
		// Log detailed error on server side only
		console.error('GraphQL ordersCount failed', err);
		// Deprecated REST fallback as a last resort
		try {
			const url = `https://${storeDomain}/admin/api/2025-07/orders/count.json`;
			const r = await fetch(url, {
				headers: { 'X-Shopify-Access-Token': accessToken! },
			});
			if (!r.ok) {
				const body = await r.text();
				return res.status(r.status).json({
					error: 'REST fallback failed',
					status: r.status,
					statusText: r.statusText,
					url,
					bodySnippet: body.slice(0, 300),
				});
			}
			const json = await r.json();
			return res.status(200).json({ totalOrders: json.count });
		} catch (restErr: any) {
			console.error('REST orders/count failed', restErr);
			res.status(500).json({ error: 'Failed to fetch order count', detail: String(err?.message || err) });
		}
	}
}
