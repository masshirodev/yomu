import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { parseEvent, type SourceKind } from '$lib/parse';
import { appendLines, currentSession, listNames, noteGameReading, noteName } from '$lib/server/db';
import { cleanMarkup, type Dialect } from '$lib/markup';
import { workForIngest } from '$lib/server/work';
import { publish } from '$lib/server/bus';
import { saveState, stateFor } from '$lib/server/parse-state';
import { requireIngestToken } from '$lib/server/auth';

const SOURCES: SourceKind[] = ['clipboard', 'cli', 'manual'];

/**
 * The single entry point for text arriving from the game.
 *
 * Deliberately source-agnostic: the clipboard bridge posts here today, and a
 * TextractorCLI reader or an OCR fallback would post the same shape. Nothing
 * downstream of this endpoint knows how the text was obtained.
 */
export const POST: RequestHandler = async ({ request }) => {
	requireIngestToken(request);

	const body = await request.json().catch(() => null);
	if (!body || typeof body.text !== 'string') error(400, 'expected { text, source?, ts? }');

	const source: SourceKind = SOURCES.includes(body.source) ? body.source : 'clipboard';

	// The sender's clock wins. It is the one next to the human, and the whole
	// point of timestamping at the event is that later hops add latency.
	const ts = Number.isFinite(body.ts) ? Number(body.ts) : Date.now();

	// The work the bridge says it is playing. Unknown slugs create a work rather
	// than erroring: starting a new VN should not need a setup step first.
	const work = workForIngest(body?.work, body?.title, body?.dialect);
	const sessionId = currentSession(work.id, ts);

	// Engine markup comes off before anything else looks at the text. Left in,
	// `%p-1;` and `#ff8A00;` are tokenised as words and ranked as vocabulary.
	//
	// The ruby it carries is kept, not discarded: it is the strongest reading
	// source there is. 運命石の扉 reads シュタインズゲート, which no dictionary
	// and no tokenizer will ever produce.
	const { text, ruby } = cleanMarkup(body.text, (work.dialect as Dialect) ?? 'none');
	for (const r of ruby) noteGameReading(work.id, r.base, r.reading);

	// A speaker name arriving as its own event is held until the line it belongs
	// to shows up, so attribution survives name and dialogue being on separate
	// Textractor threads.
	// Known names let the parser spot third-person narration about a character
	// (ヒロは…) and refuse to attribute it to them, which is how narration was
	// getting labelled as dialogue.
	const known = listNames(work.id).map((n) => n.surface);

	const { lines, state } = parseEvent(
		{ source, text, ts, thread: body.thread },
		stateFor(sessionId),
		{ names: known, now: ts }
	);
	saveState(sessionId, state);

	// Every speaker the name thread produces is a character name the tokenizer
	// does not know. Collecting them here means the cast assembles itself as the
	// story introduces it, and only the readings ever need typing.
	for (const line of lines) {
		if (line.speaker) noteName(work.id, line.speaker, ts);
	}

	if (lines.length === 0) return json({ accepted: 0 });

	const stored = appendLines(sessionId, source, lines, ts);
	publish(work.id, stored);

	return json({ accepted: stored.length });
};
