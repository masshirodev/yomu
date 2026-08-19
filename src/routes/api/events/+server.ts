import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolveWork } from '$lib/server/work';
import { currentSession, recordEvent } from '$lib/server/db';

/**
 * Phase 2 telemetry sink.
 *
 * Nothing reads this table yet, and that is deliberate. Dwell time and lookup
 * history cannot be reconstructed after the fact, so every session read without
 * instrumentation is permanently lost to the known-word model. It gets written
 * from the first day the reader works, months before anything consumes it.
 */
const TYPES = new Set(['lookup', 'explain', 'reveal']);

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (!body || !TYPES.has(body.type)) error(400, 'unknown event type');

	const at = Number.isFinite(body.at) ? Number(body.at) : Date.now();
	// Scoped through the session, which belongs to a work -- so a lookup logged
	// while reading one VN cannot rank a word in another one's mining queue.
	const work = resolveWork(body.work);
	recordEvent(
		currentSession(work.id, at),
		body.lineId ?? null,
		body.type,
		body.payload ?? null,
		at
	);

	return json({ ok: true });
};
