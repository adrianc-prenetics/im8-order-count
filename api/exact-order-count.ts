import { createAdminApiClient } from '@shopify/admin-api-client';

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

	const queryFilter = typeof req?.query?.query === 'string' ? req.query.query : undefined;
	const shouldWait = String(req?.query?.wait || '0') === '1';
	const maxWaitMs = Math.min(parseInt(String(req?.query?.timeoutMs || '18000'), 10) || 18000, 30000);

	try {
		const CURRENT = `query { currentBulkOperation { id status type objectCount url partialDataUrl createdAt } }`;
		const startBulkQuery = `mutation Run {
			bulkOperationRunQuery(query: """
				{
					orders(first: 250${queryFilter ? `, query: \"${escapeQuotes(queryFilter)}\"` : ''}) {
						edges { node { id } }
					}
				}
			""") {
				bulkOperation { id status type }
				userErrors { field message }
			}
		}`;

		// First check current operation
		let { data } = await client.request(CURRENT);
		let op = data?.currentBulkOperation;

		if (!op || op.status === 'CANCELED' || op.status === 'FAILED' || op.status === 'EXPIRED' || op.status === 'IDLE') {
			// Start a new bulk op that emits one line per order id
			const started = await client.request(startBulkQuery);
			const errs = started?.bulkOperationRunQuery?.userErrors;
			if (errs && errs.length) {
				return res.status(400).json({ error: 'Bulk start failed', errors: errs });
			}
			op = started?.bulkOperationRunQuery?.bulkOperation || null;
		}

		if (!shouldWait) {
			return res.status(200).json({ status: op?.status || 'UNKNOWN', objectCount: op?.objectCount ? Number(op.objectCount) : undefined });
		}

		// Poll for completion within timeout
		const start = Date.now();
		while (Date.now() - start < maxWaitMs) {
			({ data } = await client.request(CURRENT));
			op = data?.currentBulkOperation;
			if (op && op.status === 'COMPLETED') {
				return res.status(200).json({ status: op.status, exactOrders: Number(op.objectCount || 0) });
			}
			if (op && (op.status === 'FAILED' || op.status === 'CANCELED' || op.status === 'EXPIRED')) {
				return res.status(500).json({ status: op.status, error: 'Bulk operation did not complete successfully' });
			}
			await sleep(1200);
		}

		return res.status(202).json({ status: op?.status || 'PENDING', message: 'Still running, poll again or pass wait=1&timeoutMs=30000' });
	} catch (err: any) {
		console.error('exact-order-count failed', err);
		res.status(500).json({ error: 'Failed to run exact order count', detail: String(err?.message || err) });
	}
}

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

function escapeQuotes(input: string) {
	return input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}


