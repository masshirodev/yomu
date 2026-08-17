import type { Token } from './tokenize';
import { furigana } from './furigana';

/**
 * Character names as single units.
 *
 * kuromoji's dictionary does not contain this cast, so it splits them and reads
 * the pieces separately: 桜羽エマ comes back as 桜[さくら] 羽[わ] エマ rather
 * than 桜羽[さくらば]エマ. Names are also the highest-frequency tokens in a
 * visual novel, so getting them wrong is wrong constantly.
 *
 * Readings are curated rather than looked up. JMnedict does contain these
 * surnames, but offers four readings for 桜羽 and eight for 橘, and the one it
 * marks for 桜羽 is さくらは while the game's own romanisation is Sakuraba. A
 * dictionary that confidently supplies a wrong reading is worse here than no
 * dictionary at all, and the cast is small enough to fill in by hand once.
 *
 * The names themselves are discovered automatically from the speaker thread, so
 * only the reading ever needs a human.
 */

export type NameEntry = {
	surface: string;
	/** Hiragana. Null until a human fills it in; the name still merges without it. */
	reading: string | null;
};

/**
 * Merge token runs that spell a known name into a single token.
 *
 * Longest match wins, so 桜羽エマ is preferred over a bare 桜羽 when both are
 * known -- otherwise the full name would never form.
 */
export function applyNames(tokens: Token[], names: NameEntry[]): Token[] {
	if (names.length === 0 || tokens.length === 0) return tokens;

	const byLength = [...names].sort((a, b) => b.surface.length - a.surface.length);
	const out: Token[] = [];

	let i = 0;
	while (i < tokens.length) {
		const matched = matchAt(tokens, i, byLength);
		if (!matched) {
			out.push(tokens[i]);
			i += 1;
			continue;
		}

		const { name, span } = matched;
		out.push({
			surface: name.surface,
			lemma: name.surface,
			reading: name.reading,
			// Proper noun. kuromoji would have said 名詞 for the fragments anyway,
			// but marking it lets the reader treat names differently later.
			pos: '名詞',
			segments: furigana(name.surface, name.reading),
			lookupable: true
		});
		i += span;
	}

	return out;
}

/** The longest known name starting exactly at token `i`, if any. */
function matchAt(
	tokens: Token[],
	i: number,
	byLength: NameEntry[]
): { name: NameEntry; span: number } | null {
	for (const name of byLength) {
		let consumed = '';
		let span = 0;

		while (i + span < tokens.length && consumed.length < name.surface.length) {
			consumed += tokens[i + span].surface;
			span += 1;
		}

		// Must align exactly on a token boundary. A name that ends mid-token would
		// mean splitting a word kuromoji analysed, which is worse than not matching.
		if (consumed === name.surface) return { name, span };
	}

	return null;
}
