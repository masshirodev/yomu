import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	attemptById,
	attemptsForLine,
	characterFacts,
	contextLines,
	currentSession,
	lineWithSeq,
	recordVerdict,
	saveAttempt,
	storyDigests
} from '$lib/server/db';
import { buildContext } from '$lib/context';
import { buildGradePrompt, type Verdict } from '$lib/grade';
import { explainConfigured, runProvider } from '$lib/server/explain';

/** Previously written attempts for a line, so a reload does not lose them. */
export const GET: RequestHandler = ({ url }) => {
	const lineId = Number(url.searchParams.get('lineId'));
	if (!Number.isFinite(lineId)) error(400, 'expected lineId');

	return json({
		attempts: attemptsForLine(lineId).map((a) => ({
			id: a.id,
			guess: a.guess,
			verdict: a.verdict ? JSON.parse(a.verdict) : null,
			error: a.error
		}))
	});
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);

	// Retrying an existing attempt reuses its stored guess. Grading is the flaky
	// half; the writing is not, and asking for it again to recover from a
	// provider hiccup would be the worst possible response to one.
	const retryId = Number(body?.attemptId);
	const existing = Number.isFinite(retryId) ? attemptById(retryId) : null;

	const lineId = existing ? existing.line_id : Number(body?.lineId);
	const guess = existing
		? existing.guess
		: typeof body?.guess === 'string'
			? body.guess.trim()
			: '';

	if (!Number.isFinite(lineId)) error(400, 'expected { lineId, guess } or { attemptId }');
	if (!guess) error(400, 'guess is empty');

	const line = lineWithSeq(lineId);
	if (!line) error(404, 'no such line');

	// Stored before grading is attempted. The guess is the irreplaceable half:
	// it is the only record of what was understood at this point in the story,
	// and a grader that is offline, slow or later changed must never cost it.
	const id = existing ? existing.id : saveAttempt(lineId, currentSession(), guess);

	if (!explainConfigured()) {
		return json({ id, guess, verdict: null, error: 'no grader configured' });
	}

	// Same read-position boundary as explanations. A grader that reached past the
	// reader would spoil the story from inside a study feature.
	const ctx = buildContext({
		currentSeq: line.seq,
		digests: storyDigests(),
		facts: characterFacts(),
		lines: contextLines(line.session_id)
	});

	try {
		const verdict = await runProvider<Verdict>(
			buildGradePrompt({ line: line.text, guess, speaker: line.speaker, ctx }),
			'gist'
		);
		recordVerdict(id, JSON.stringify(verdict), null);
		return json({ id, guess, verdict });
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		recordVerdict(id, null, message);
		// 200, not an error: the attempt was saved, which is the part that matters.
		// Failing the request would suggest the writing was lost when it was not.
		return json({ id, guess, verdict: null, error: message });
	}
};
