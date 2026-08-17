import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { parseEvent, type SourceKind } from '$lib/parse';
import { appendLines, currentSession, listNames, noteName } from '$lib/server/db';
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

	const sessionId = currentSession(ts);

	// A speaker name arriving as its own event is held until the line it belongs
	// to shows up, so attribution survives name and dialogue being on separate
	// Textractor threads.
	// Known names let the parser spot third-person narration about a character
	// (ヒロは…) and refuse to attribute it to them, which is how narration was
	// getting labelled as dialogue.
	const known = listNames().map((n) => n.surface);

	const { lines, state } = parseEvent(
		{ source, text: body.text, ts, thread: body.thread },
		stateFor(sessionId),
		{ names: known, now: ts }
	);
	saveState(sessionId, state);

	// Every speaker the name thread produces is a character name the tokenizer
	// does not know. Collecting them here means the cast assembles itself as the
	// story introduces it, and only the readings ever need typing.
	for (const line of lines) {
		if (line.speaker) noteName(line.speaker, ts);
	}

	if (lines.length === 0) return json({ accepted: 0 });

	const stored = appendLines(sessionId, source, lines, ts);
	publish(stored);

	return json({ accepted: stored.length });
};
