import { createAdminApiClient } from '@shopify/admin-api-client';

const accessToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN || process.env.SHOPIFY_TOKEN;
const storeDomain = process.env.SHOPIFY_DOMAIN;

const client = createAdminApiClient({
	storeDomain: storeDomain!,
	accessToken: accessToken!,
	apiVersion: '2025-07',
});

// In-memory de-duplication and caching for hot lambdas (best-effort)
let lastCompletedCache: { exactOrders: number; completedAt: string } | null = null;
let startInFlight: Promise<void> | null = null;
let lastStartTsMs = 0;
const MIN_START_INTERVAL_MS = 60_000; // don't start more than once per minute by default

export default async function handler(req: any, res: any) {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Small CDN cache to protect against stampedes
  res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=30');

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
	const force = String(req?.query?.force || '0') === '1';
	const maxAgeMinutes = Math.min(parseInt(String(req?.query?.maxAgeMinutes || '60'), 10) || 60, 1440);
	const minStartIntervalMs = Math.min(
		parseInt(String(req?.query?.minStartIntervalMs || String(MIN_START_INTERVAL_MS)), 10) || MIN_START_INTERVAL_MS,
		5 * 60_000,
	);

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

		// If we have a completed operation and it's fresh enough, return immediately
		if (op && op.status === 'COMPLETED') {
			const createdAt = new Date(op.createdAt);
			const ageMinutes = (Date.now() - createdAt.getTime()) / 60000;
			const exact = Number(op.objectCount || 0);
			if (!force && ageMinutes <= maxAgeMinutes) {
				lastCompletedCache = { exactOrders: exact, completedAt: op.createdAt };
				console.log('[exact-order-count] status=COMPLETED source=currentBulkOperation exactOrders=' + exact + ' ageMinutes=' + ageMinutes.toFixed(2));
				res.setHeader('X-Exact-Status', 'COMPLETED');
				res.setHeader('X-Exact-Orders', String(exact));
				res.setHeader('X-Exact-Source', 'currentBulkOperation');
				res.setHeader('X-Exact-Completed-At', op.createdAt);
				res.setHeader('Server-Timing', `exact;desc="${exact}"`);
				return res.status(200).json({ status: op.status, exactOrders: exact, completedAt: op.createdAt, ageMinutes });
			}
		}

		// If cache exists and is fresh enough, serve without hitting Shopify again
		if (lastCompletedCache) {
			const ageMinutes = (Date.now() - new Date(lastCompletedCache.completedAt).getTime()) / 60000;
			if (!force && ageMinutes <= maxAgeMinutes) {
				console.log('[exact-order-count] status=COMPLETED source=memory-cache exactOrders=' + lastCompletedCache.exactOrders + ' ageMinutes=' + ageMinutes.toFixed(2));
				res.setHeader('X-Exact-Status', 'COMPLETED');
				res.setHeader('X-Exact-Orders', String(lastCompletedCache.exactOrders));
				res.setHeader('X-Exact-Source', 'memory-cache');
				res.setHeader('X-Exact-Completed-At', lastCompletedCache.completedAt);
				res.setHeader('Server-Timing', `exact;desc="${lastCompletedCache.exactOrders}"`);
				return res.status(200).json({ status: 'COMPLETED', exactOrders: lastCompletedCache.exactOrders, completedAt: lastCompletedCache.completedAt, ageMinutes });
			}
		}

		const tooSoonToStart = Date.now() - lastStartTsMs < minStartIntervalMs;
		if (
			!op ||
			op.status === 'CANCELED' ||
			op.status === 'FAILED' ||
			op.status === 'EXPIRED' ||
			op.status === 'IDLE' ||
			(op.status === 'COMPLETED' && force)
		) {
			if (!force && tooSoonToStart) {
				// Avoid starting again too soon; return current status
				console.log('[exact-order-count] start-suppressed status=' + (op?.status || 'PENDING'));
				return res.status(202).json({ status: op?.status || 'PENDING', message: 'Start suppressed to protect rate limits; try again shortly.' });
			}
			// Start a new bulk op that emits one line per order id, de-duped across concurrent requests
			if (!startInFlight) {
				startInFlight = (async () => {
					const started = await client.request(startBulkQuery);
					const errs = started?.bulkOperationRunQuery?.userErrors;
					if (errs && errs.length) {
						throw new Error('Bulk start failed: ' + JSON.stringify(errs));
					}
					lastStartTsMs = Date.now();
				})();
			}
			try {
				await startInFlight;
			} finally {
				startInFlight = null;
			}
			({ data } = await client.request(CURRENT));
			op = data?.currentBulkOperation || null;
		}

		if (!shouldWait) {
			const oc = op?.objectCount ? Number(op.objectCount) : undefined;
			console.log('[exact-order-count] immediate status=' + (op?.status || 'UNKNOWN') + (oc !== undefined ? ' objectCount=' + oc : ''));
			if (oc !== undefined) {
				res.setHeader('X-Exact-Orders', String(oc));
				res.setHeader('X-Exact-Status', op?.status || 'UNKNOWN');
				res.setHeader('X-Exact-Source', 'currentBulkOperation');
				if (op?.status === 'COMPLETED' && op?.createdAt) {
					res.setHeader('X-Exact-Completed-At', op.createdAt);
				}
			}
			return res.status(200).json({ status: op?.status || 'UNKNOWN', objectCount: oc, completedAt: op?.createdAt });
		}

		// Poll for completion within timeout
		const start = Date.now();
		const basePollMs = 1400;
		while (Date.now() - start < maxWaitMs) {
			({ data } = await client.request(CURRENT));
			op = data?.currentBulkOperation;
			if (op && op.status === 'COMPLETED') {
				const exact = Number(op.objectCount || 0);
				lastCompletedCache = { exactOrders: exact, completedAt: op.createdAt };
				console.log('[exact-order-count] status=COMPLETED source=poll exactOrders=' + exact);
				res.setHeader('X-Exact-Status', 'COMPLETED');
				res.setHeader('X-Exact-Orders', String(exact));
				res.setHeader('X-Exact-Source', 'poll');
				res.setHeader('X-Exact-Completed-At', op.createdAt);
				res.setHeader('Server-Timing', `exact;desc="${exact}"`);
				return res.status(200).json({ status: op.status, exactOrders: exact, completedAt: op.createdAt });
			}
			if (op && (op.status === 'FAILED' || op.status === 'CANCELED' || op.status === 'EXPIRED')) {
				return res.status(500).json({ status: op.status, error: 'Bulk operation did not complete successfully' });
			}
			await sleep(basePollMs);
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


