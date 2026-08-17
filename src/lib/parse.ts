/**
 * Normalisation of raw text-hook events into reader lines.
 *
 * Everything here is a pure function over a captured event, so it is testable
 * against the Phase 0 fixtures without launching the game. That matters: the
 * game has to be running to produce a single new sample, and iterating on a
 * parser at that cost is miserable.
 */

/** Where an event came from. The reader does not care; the parser sometimes does. */
export type SourceKind = 'clipboard' | 'cli' | 'manual';

export type RawEvent = {
	source: SourceKind;
	text: string;
	/** Client epoch ms. Authoritative — the server's clock is not the reader's. */
	ts: number;
	/** Textractor thread identifier, when the source can supply one. */
	thread?: string;
};

export type ParsedLine = {
	/**
	 * `dialogue` when a speaker was identified, `narration` otherwise.
	 *
	 * This is not cosmetic. Narration is the register with no listening
	 * scaffold behind it and defaults to heavier support in the reader.
	 */
	kind: 'dialogue' | 'narration';
	speaker: string | null;
	text: string;
};

/**
 * The game appends U+200B to lines when a translation extension is in the
 * chain. The raw hook does not, but stripping defensively costs nothing and
 * the failure mode -- an invisible character wedged into every dictionary
 * lookup -- is disproportionately annoying to debug.
 */
// Written as escapes on purpose. These characters are invisible, and a literal
// U+200B sitting in a character class is unreviewable and easy to delete by
// accident -- which is the same property that makes it worth stripping at all.
// Only the two that actually turn up: U+200B, which the game appends, and
// U+FEFF, which arrives as a stray BOM. ZWNJ and ZWJ are deliberately excluded
// -- they never occur in this text, and stripping ZWJ would corrupt any emoji
// sequence that ever passes through.
const ZERO_WIDTH = '\\u200B\\uFEFF';
const TRAILING_JUNK = new RegExp(`[${ZERO_WIDTH}\\s]+$`, 'u');
const LEADING_JUNK = new RegExp(`^[${ZERO_WIDTH}\\s]+`, 'u');

export function clean(text: string): string {
	return text.replace(LEADING_JUNK, '').replace(TRAILING_JUNK, '');
}

/**
 * The name thread emits its payload twice, separated by a blank line:
 * `桜羽エマ\n\n桜羽エマ`. Collapse that to one.
 */
function dedupeRepeated(parts: string[]): string[] {
	const out: string[] = [];
	for (const p of parts) {
		if (out.length === 0 || out[out.length - 1] !== p) out.push(p);
	}
	return out;
}

/**
 * A speaker name is short and carries no sentence punctuation. Dialogue and
 * narration both do, reliably, because Japanese prose terminates on 。！？ or
 * a trailing dash. Length alone would misclassify short exclamations such as
 * 「ちがう！」, hence both conditions.
 */
// U+30FC (ー) is deliberately absent: it is the katakana prolonged sound mark and
// appears in perfectly ordinary names such as 橘シェリー. U+2015 (―) is present,
// because that is the narration dash.
const SENTENCE_MARKS = /[。、！？…‥「」（）―]/u;
const MAX_NAME_LENGTH = 12;

function looksLikeSpeaker(text: string): boolean {
	return text.length > 0 && text.length <= MAX_NAME_LENGTH && !SENTENCE_MARKS.test(text);
}

/**
 * Does this look like text from the game at all?
 *
 * The clipboard is shared with everything else on the machine, so the bridge
 * sees every copy: shell commands, URLs, and -- this is not hypothetical, it is
 * what happened -- an ingest token pasted from a setup command, which was then
 * POSTed and written to the line store.
 *
 * Requiring Japanese is a crude filter and the right one. Every line this VN
 * produces contains kana or kanji; almost nothing accidentally copied does. The
 * asymmetry is the point: dropping a rare all-ASCII game line costs one missing
 * line, while accepting one copied password costs a credential in a database
 * that was never meant to hold one.
 */
const JAPANESE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

export function containsJapanese(text: string): boolean {
	return JAPANESE.test(text);
}

/**
 * A speaker name seen with no line yet attached, carried to the next event.
 *
 * Textractor's Copy to Clipboard follows whichever thread is *selected*, so name
 * and dialogue normally cannot arrive together -- confirmed by contrast between
 * two Phase 0 captures, one entirely bare names, the other entirely lines.
 * Merging them needs Thread Linker, which may or may not ever be set up.
 *
 * Carrying the speaker across events costs almost nothing and means attribution
 * works the moment both threads do reach us, by whatever route, without the
 * parser needing to know how.
 */
export type ParseState = { pendingSpeaker: string | null };

export const emptyState = (): ParseState => ({ pendingSpeaker: null });

export type ParseResult = { lines: ParsedLine[]; state: ParseState };

/**
 * Turn one raw event into zero or more reader lines.
 *
 * Returns an array because a merged event can carry a speaker and their line
 * together, and because a backlog flush can carry several at once -- the
 * prologue arrives as a single 478-character event.
 *
 * State is passed in and out rather than held in a module global, so the whole
 * thing stays pure and testable, and so two concurrent sessions cannot bleed
 * speakers into each other.
 */
export function parseEvent(event: RawEvent, state: ParseState = emptyState()): ParseResult {
	const parts = dedupeRepeated(
		event.text
			.split('\n')
			.map(clean)
			// Second line of defence. The bridge filters before sending so secrets
			// never leave the machine; this makes sure nothing non-Japanese is
			// stored even if some other source posts it.
			.filter((p) => p.length > 0 && containsJapanese(p))
	);

	const lines: ParsedLine[] = [];
	let pendingSpeaker = state.pendingSpeaker;

	for (const part of parts) {
		// A short unpunctuated fragment is a name. It is never emitted as a line
		// of its own -- the reader would render it as a sentence -- it is held
		// until the text it belongs to arrives.
		if (looksLikeSpeaker(part)) {
			pendingSpeaker = part;
			continue;
		}
		lines.push({
			kind: pendingSpeaker ? 'dialogue' : 'narration',
			speaker: pendingSpeaker,
			text: part
		});
		pendingSpeaker = null;
	}

	return { lines, state: { pendingSpeaker } };
}
