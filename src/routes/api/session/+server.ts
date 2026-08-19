import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	currentSession,
	sessionInfo,
	sessionSamples,
	setSessionMode,
	currentWork
} from '$lib/server/db';
import { summarise } from '$lib/stats';

/**
 * The current session and what it looks like so far.
 *
 * Phase 2 writes telemetry that nothing acts on yet, which makes it very easy
 * for it to be quietly broken for weeks. Surfacing the numbers is what makes
 * "logged but inert" verifiable rather than an article of faith.
 */
export const GET: RequestHandler = () => {
	const id = currentSession(currentWork().id);
	const { advances, lookups } = sessionSamples(id);
	const info = sessionInfo(id);

	return json({
		session: { id, mode: info.mode, startedAt: info.started_at },
		stats: summarise(advances, lookups)
	});
};

const MODES = new Set(['reading', 'skimming', 'unknown']);

export const PATCH: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (!body || !MODES.has(body.mode)) error(400, 'mode must be reading, skimming or unknown');

	const id = currentSession(currentWork().id);
	// The declared mode wins over the inferred one. The heuristic exists to catch
	// the case where nobody remembered to say, not to overrule someone who did.
	setSessionMode(id, body.mode);

	return json({ session: { id, mode: body.mode } });
};
