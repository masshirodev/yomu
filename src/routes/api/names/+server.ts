import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listNames, setNameReading } from '$lib/server/db';
import { resolveWork } from '$lib/server/work';

/**
 * Character names and their readings.
 *
 * Browser-only, so it stays behind Authentik with the reader. Names arrive on
 * their own from the speaker thread; this exists so the readings can be filled
 * in, which is the one part no dictionary can be trusted with.
 */
export const GET: RequestHandler = ({ url }) =>
	json({ names: listNames(resolveWork(url.searchParams.get('work')).id) });

export const PATCH: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (!body || typeof body.surface !== 'string') error(400, 'expected { surface, reading }');

	const work = resolveWork(body.work);
	const reading = typeof body.reading === 'string' ? body.reading.trim() : null;
	setNameReading(work.id, body.surface, reading);

	return json({ names: listNames(work.id) });
};
