import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import {
	cachedExplanation,
	characterFacts,
	contextLines,
	lineWithSeq,
	saveExplanation,
	storyDigests,
	workForSession
} from '$lib/server/db';
import { buildContext } from '$lib/context';
import { buildPrompt, cacheKey, explainConfigured, runExplain } from '$lib/server/explain';

/**
 * Explain one line, in the story as the reader has read it.
 *
 * Browser-only, so it stays behind Authentik with the reader.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const lineId = Number(body?.lineId);
	if (!Number.isFinite(lineId)) error(400, 'expected { lineId }');

	const line = lineWithSeq(lineId);
	if (!line) error(404, 'no such line');

	// The work follows the line, not the reader's current one. Explaining an old
	// line must use its own story's context, whichever VN is open now.
	const work = workForSession(line.session_id);

	// Everything the model may know, bounded by where the reader is. The line
	// being explained is the boundary, so nothing later can reach the prompt.
	const ctx = buildContext({
		currentSeq: line.seq,
		digests: storyDigests(work),
		facts: characterFacts(work),
		lines: contextLines(work)
	});

	// A span must be part of the line it claims to be from, so a caller cannot
	// smuggle arbitrary text into the prompt through this field.
	const rawSpan = typeof body?.span === 'string' ? body.span.trim() : '';
	const span = rawSpan && line.text.includes(rawSpan) ? rawSpan : null;

	const prompt = buildPrompt(line.text, ctx, span);
	const key = cacheKey(prompt);

	const cached = cachedExplanation(key);
	if (cached?.status === 'done' && cached.result) {
		return json({ explanation: JSON.parse(cached.result), cached: true });
	}

	if (!explainConfigured()) error(503, 'no explain provider configured');

	try {
		const explanation = await runExplain(prompt);
		saveExplanation(
			key,
			lineId,
			prompt,
			JSON.stringify(explanation),
			env.YOMU_EXPLAIN_MODEL || 'opencode',
			null
		);
		return json({ explanation, cached: false });
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		// Recorded as failed rather than dropped, so a provider that is broken
		// shows up as a pattern instead of one-off errors in the reader.
		saveExplanation(key, lineId, prompt, null, env.YOMU_EXPLAIN_MODEL || 'opencode', message);
		error(502, `explain failed: ${message}`);
	}
};
