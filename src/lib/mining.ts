/**
 * Turning the friction log into flashcard candidates.
 *
 * Ranking only. What a candidate becomes on a card lives in `$lib/enrich`,
 * because a card is now built from the dictionary, the tokenizer and a provider
 * call rather than from a candidate alone.
 *
 * The premise of the whole project: what you actually looked up is better
 * evidence of what you do not know than any frequency list. A word ranks here
 * because it cost you something, not because a corpus says it is common.
 *
 * Candidates are proposed, never created. Auto-mining floods a deck and kills
 * the review habit inside a week, which costs far more than a few words missed.
 */

export type LookupRecord = {
	lemma: string;
	surface: string;
	pos: string;
	sessionId: number;
	at: number;
	lineId: number | null;
};

/**
 * Word classes that are never worth a flashcard.
 *
 * Found the hard way: the first real candidate list came back with は (topic
 * particle) ranked fourth. Clicking a particle is still useful friction data
 * worth logging -- it says something was grammatically unclear -- but it is not
 * vocabulary, and a deck of particles is precisely the flood that kills a review
 * habit. Grammar gaps belong in a grammar card, which is Phase 3's problem.
 */
const FUNCTION_WORD_POS = new Set([
	'助詞', // particles: は, が, を, に
	'助動詞', // auxiliaries: だ, ます, れる
	'接続詞', // conjunctions
	'記号', // punctuation
	'補助記号',
	'フィラー', // あー, えーと
	'感動詞' // interjections
]);

/**
 * A single kana is a fragment, not a word.
 *
 * The capture is full of stuttering -- ボ、ボクは / ひっ、ひっ、ひ…… -- and
 * kuromoji tokenises each false start separately. ボ arrived as a candidate on
 * the first run.
 */
function isFragment(lemma: string): boolean {
	return lemma.length < 2 && !/\p{Script=Han}/u.test(lemma);
}

export function isMineable(record: { lemma: string; pos: string }): boolean {
	if (!record.lemma) return false;
	if (FUNCTION_WORD_POS.has(record.pos)) return false;
	return !isFragment(record.lemma);
}

export type Candidate = {
	lemma: string;
	/** The most recently seen written form, which is what to put on the card. */
	surface: string;
	lookups: number;
	sessions: number;
	score: number;
	lastAt: number;
	lineId: number | null;
};

/**
 * A word looked up across three different evenings is a real gap. The same word
 * clicked three times in one minute is usually the dictionary panel being
 * reopened, or a sentence being reread. Weighting sessions above raw count is
 * what separates those two.
 */
export const SESSION_WEIGHT = 3;

export function rankCandidates(lookups: LookupRecord[]): Candidate[] {
	const byLemma = new Map<string, LookupRecord[]>();

	for (const l of lookups) {
		if (!isMineable(l)) continue;
		const list = byLemma.get(l.lemma);
		if (list) list.push(l);
		else byLemma.set(l.lemma, [l]);
	}

	const candidates: Candidate[] = [];

	for (const [lemma, records] of byLemma) {
		const ordered = [...records].sort((a, b) => a.at - b.at);
		const latest = ordered[ordered.length - 1];
		const sessions = new Set(ordered.map((r) => r.sessionId)).size;

		candidates.push({
			lemma,
			surface: latest.surface || lemma,
			lookups: ordered.length,
			sessions,
			score: sessions * SESSION_WEIGHT + ordered.length,
			lastAt: latest.at,
			// The line it was most recently met in. A card carrying the sentence you
			// actually hit the word in is worth several carrying a dictionary example.
			lineId: latest.lineId
		});
	}

	// Highest friction first; most recent breaks ties so a review session starts
	// with what is still fresh.
	return candidates.sort((a, b) => b.score - a.score || b.lastAt - a.lastAt);
}
