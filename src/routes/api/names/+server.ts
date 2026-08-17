import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listNames, setNameReading } from '$lib/server/db';

/**
 * Character names and their readings.
 *
 * Browser-only, so it stays behind Authentik with the reader. Names arrive on
 * their own from the speaker thread; this exists so the readings can be filled
 * in, which is the one part no dictionary can be trusted with.
 */
export const GET: RequestHandler = () => json({ names: listNames() });

export const PATCH: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (!body || typeof body.surface !== 'string') error(400, 'expected { surface, reading }');

	const reading = typeof body.reading === 'string' ? body.reading.trim() : null;
	setNameReading(body.surface, reading);

	return json({ names: listNames() });
};
