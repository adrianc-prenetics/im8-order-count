import { createAdminApiClient } from '@shopify/admin-api-client';

const accessToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN || process.env.SHOPIFY_TOKEN;
const storeDomain = process.env.SHOPIFY_DOMAIN;

const client = createAdminApiClient({
	storeDomain: storeDomain!,
	accessToken: accessToken!,
	apiVersion: '2025-07',
});

// Aggregation streams a large JSONL (orders + their line items); give it headroom.
export const config = { maxDuration: 300 };

interface ApiRequest {
	method?: string;
	query?: Record<string, string | string[] | undefined>;
}

interface ApiResponse {
	setHeader(name: string, value: string): void;
	status(code: number): ApiResponse;
	json(body: unknown): ApiResponse;
	end(): void;
}

interface BulkOperation {
	id: string;
	status: string;
	type?: string;
	objectCount?: string | number | null;
	url?: string | null;
	partialDataUrl?: string | null;
	createdAt: string;
}

interface CurrentBulkOpData {
	currentBulkOperation: BulkOperation | null;
}

interface RunQueryData {
	bulkOperationRunQuery: {
		bulkOperation: BulkOperation | null;
		userErrors: Array<{ field?: string[]; message: string }>;
	};
}

interface Totals {
	exactOrders: number;
	exactServings: number;
	lineItems: number;
	unmatchedLineItems: number;
}

interface CompletedCache extends Totals {
	opId: string;
	completedAt: string;
}

let lastCompletedCache: CompletedCache | null = null;
let startInFlight: Promise<void> | null = null;
let aggregateInFlight: Promise<Totals> | null = null;
let lastStartTsMs = 0;
const MIN_START_INTERVAL_MS = 60_000;

// Servings per line item — mirrors the authoritative Databricks SQL CASE exactly.
// Matched case-insensitively against `${title} ${variantTitle}`; first match wins.
function servingsForLine(title: string, variantTitle: string): number {
	const t = `${title} ${variantTitle}`.toLowerCase();
	const has = (needle: string): boolean => t.includes(needle);
	if (has('quarterly') && has('beckham')) return 180;
	if (has('quarterly')) return 90;
	if (has('beckham stack')) return 60;
	if (has('double') || has('duo') || has('60 days')) return 60;
	if (has('essentials') || has('longevity')) return 30;
	if (has('14-day')) return 14;
	if (has('10 sticks') || has('10 pack') || has('10 sachet')) return 10;
	if (has('7-day') || has('7 sticks') || has('7 pack') || has('trial') || has('7-count')) return 7;
	if (has('6 sticks')) return 6;
	if (has('5 pack') || has('5 sticks') || has('5 sachet')) return 5;
	return 0; // accessories & free gifts
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

async function aggregateFromUrl(url: string): Promise<Totals> {
	const resp = await fetch(url);
	if (!resp.ok || !resp.body) {
		throw new Error('Failed to download bulk JSONL: ' + resp.status);
	}
	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';

	const totals: Totals = { exactOrders: 0, exactServings: 0, lineItems: 0, unmatchedLineItems: 0 };
	// Orders precede their line items in bulk output; track cancelled order ids so we
	// can exclude their line items (mirrors `o.cancelled_at IS NULL`).
	const cancelledOrderIds = new Set<string>();

	const processLine = (line: string): void => {
		const trimmed = line.trim();
		if (!trimmed) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return;
		}
		const rec = asRecord(parsed);
		if (!rec) return;

		const parentId = typeof rec.__parentId === 'string' ? rec.__parentId : undefined;
		if (parentId) {
			// Line-item row.
			if (cancelledOrderIds.has(parentId)) return;
			const qty = typeof rec.quantity === 'number' ? rec.quantity : 0;
			if (qty <= 0) return;
			totals.lineItems += 1;
			const servings = servingsForLine(asString(rec.title), asString(rec.variantTitle));
			if (servings === 0) totals.unmatchedLineItems += 1;
			totals.exactServings += servings * qty;
			return;
		}

		const id = asString(rec.id);
		if (id.includes('/Order/')) {
			if (rec.cancelledAt != null) {
				cancelledOrderIds.add(id);
				return;
			}
			totals.exactOrders += 1;
		}
	};

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		let idx = buf.indexOf('\n');
		while (idx >= 0) {
			processLine(buf.slice(0, idx));
			buf = buf.slice(idx + 1);
			idx = buf.indexOf('\n');
		}
	}
	if (buf.length) processLine(buf);
	return totals;
}

async function aggregateOnce(op: BulkOperation): Promise<Totals> {
	if (lastCompletedCache && lastCompletedCache.opId === op.id) {
		return lastCompletedCache;
	}
	if (!op.url) {
		throw new Error('Completed bulk operation has no result url');
	}
	if (!aggregateInFlight) {
		const url = op.url;
		aggregateInFlight = aggregateFromUrl(url);
	}
	try {
		const totals = await aggregateInFlight;
		lastCompletedCache = { opId: op.id, completedAt: op.createdAt, ...totals };
		return totals;
	} finally {
		aggregateInFlight = null;
	}
}

function sendCompleted(res: ApiResponse, source: string, totals: Totals, completedAt: string, ageMinutes?: number): void {
	res.setHeader('X-Exact-Status', 'COMPLETED');
	res.setHeader('X-Exact-Orders', String(totals.exactOrders));
	res.setHeader('X-Exact-Servings', String(totals.exactServings));
	res.setHeader('X-Exact-Source', source);
	res.setHeader('X-Exact-Completed-At', completedAt);
	res.setHeader('Server-Timing', `orders;desc="${totals.exactOrders}", servings;desc="${totals.exactServings}"`);
	const servingsPerOrder = totals.exactOrders > 0 ? Math.round((totals.exactServings / totals.exactOrders) * 100) / 100 : 0;
	res.setHeader('X-Exact-Servings-Per-Order', String(servingsPerOrder));
	console.log(
		`[exact-order-count] status=COMPLETED source=${source} exactOrders=${totals.exactOrders} exactServings=${totals.exactServings} lineItems=${totals.lineItems} unmatched=${totals.unmatchedLineItems}`,
	);
	res.status(200).json({
		status: 'COMPLETED',
		exactOrders: totals.exactOrders,
		exactServings: totals.exactServings,
		servingsPerOrder,
		lineItems: totals.lineItems,
		unmatchedLineItems: totals.unmatchedLineItems,
		completedAt,
		...(typeof ageMinutes === 'number' ? { ageMinutes } : {}),
	});
}

function qp(req: ApiRequest, key: string): string | undefined {
	const v = req?.query?.[key];
	if (typeof v === 'string') return v;
	if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
	return undefined;
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=30');

	if (req.method === 'OPTIONS') {
		res.status(200).end();
		return;
	}

	if (!storeDomain || !accessToken) {
		res.status(500).json({ error: 'Missing SHOPIFY_DOMAIN or SHOPIFY_ADMIN_API_ACCESS_TOKEN' });
		return;
	}

	const queryFilter = qp(req, 'query');
	const shouldWait = (qp(req, 'wait') || '0') === '1';
	const maxWaitMs = Math.min(parseInt(qp(req, 'timeoutMs') || '18000', 10) || 18000, 30000);
	const force = (qp(req, 'force') || '0') === '1';
	const maxAgeMinutes = Math.min(parseInt(qp(req, 'maxAgeMinutes') || '60', 10) || 60, 1440);
	const minStartIntervalMs = Math.min(
		parseInt(qp(req, 'minStartIntervalMs') || String(MIN_START_INTERVAL_MS), 10) || MIN_START_INTERVAL_MS,
		5 * 60_000,
	);

	try {
		const CURRENT = `query { currentBulkOperation { id status type objectCount url partialDataUrl createdAt } }`;
		const startBulkQuery = `mutation Run {
			bulkOperationRunQuery(query: """
				{
					orders${queryFilter ? `(query: \"${escapeQuotes(queryFilter)}\")` : ''} {
						edges { node {
							id
							cancelledAt
							lineItems {
								edges { node { quantity title variantTitle } }
							}
						} }
					}
				}
			""") {
				bulkOperation { id status type }
				userErrors { field message }
			}
		}`;

		let { data } = await client.request<CurrentBulkOpData>(CURRENT);
		let op = data?.currentBulkOperation ?? null;

		if (op && op.status === 'COMPLETED') {
			const ageMinutes = (Date.now() - new Date(op.createdAt).getTime()) / 60000;
			if (!force && ageMinutes <= maxAgeMinutes) {
				const totals = await aggregateOnce(op);
				sendCompleted(res, 'currentBulkOperation', totals, op.createdAt, ageMinutes);
				return;
			}
		}

		if (lastCompletedCache) {
			const ageMinutes = (Date.now() - new Date(lastCompletedCache.completedAt).getTime()) / 60000;
			if (!force && ageMinutes <= maxAgeMinutes) {
				sendCompleted(res, 'memory-cache', lastCompletedCache, lastCompletedCache.completedAt, ageMinutes);
				return;
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
				console.log('[exact-order-count] start-suppressed status=' + (op?.status || 'PENDING'));
				res.status(202).json({ status: op?.status || 'PENDING', message: 'Start suppressed to protect rate limits; try again shortly.' });
				return;
			}
			if (!startInFlight) {
				startInFlight = (async () => {
					const started = await client.request<RunQueryData>(startBulkQuery);
					const errs = started?.data?.bulkOperationRunQuery?.userErrors;
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
			({ data } = await client.request<CurrentBulkOpData>(CURRENT));
			op = data?.currentBulkOperation ?? null;
		}

		if (!shouldWait) {
			if (op && op.status === 'COMPLETED') {
				const totals = await aggregateOnce(op);
				sendCompleted(res, 'immediate', totals, op.createdAt);
				return;
			}
			console.log('[exact-order-count] immediate status=' + (op?.status || 'UNKNOWN'));
			res.setHeader('X-Exact-Status', op?.status || 'UNKNOWN');
			res.status(202).json({ status: op?.status || 'PENDING', message: 'Bulk operation running; poll with wait=1' });
			return;
		}

		const start = Date.now();
		const basePollMs = 1400;
		while (Date.now() - start < maxWaitMs) {
			({ data } = await client.request<CurrentBulkOpData>(CURRENT));
			op = data?.currentBulkOperation ?? null;
			if (op && op.status === 'COMPLETED') {
				const totals = await aggregateOnce(op);
				sendCompleted(res, 'poll', totals, op.createdAt);
				return;
			}
			if (op && (op.status === 'FAILED' || op.status === 'CANCELED' || op.status === 'EXPIRED')) {
				res.status(500).json({ status: op.status, error: 'Bulk operation did not complete successfully' });
				return;
			}
			await sleep(basePollMs);
		}

		res.status(202).json({ status: op?.status || 'PENDING', message: 'Still running, poll again or pass wait=1&timeoutMs=30000' });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error('exact-order-count failed', message);
		res.status(500).json({ error: 'Failed to run exact order count', detail: message });
	}
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

function escapeQuotes(input: string): string {
	return input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
