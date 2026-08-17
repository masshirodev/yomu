/**
 * Splitting mixed Japanese/English prose into runs.
 *
 * Explanations come back as English with Japanese embedded in it: "Negative form
 * of 諦める (to give up). The ない form is the plain negative." Rendered as flat
 * text, the Japanese in an explanation is exactly as unreadable as the line that
 * prompted it -- which makes the explanation useless to the person who needed it.
 *
 * So the Japanese runs get the same treatment as the story text: tokenised,
 * furigana'd, clickable. This splitter is the pure part of that.
 */

export type Run = { text: string; japanese: boolean };

/**
 * Japanese punctuation counts as Japanese so that 「諦める」 stays one run
 * rather than three, and so a trailing 。 does not start an English run.
 * ー is included because it appears inside katakana words.
 */
// Written as escapes, not literals. This class contains U+3000, the ideographic
// space: invisible in source, and impossible to review or safely edit as a
// literal -- it would not even survive being copied between tools. Same reason
// the zero-width strip in parse.ts is escaped.
//   3040-30FF kana     3400-4DBF CJK ext-A   4E00-9FFF CJK   F900-FAFF compat
//   3000-303F CJK punctuation, including the ideographic space
//   FF01/FF1F/FF5E fullwidth punctuation     FF65-FF9F halfwidth katakana
const JAPANESE_CHAR =
	/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff01\uff1f\uff5e\uff65-\uff9f]/u;

/**
 * ASCII digits and Latin letters are never Japanese, even when they sit between
 * two Japanese characters. Without this, "N5" or a romaji gloss inside a
 * Japanese run would be handed to the tokenizer as if it were text to read.
 */
function isJapanese(ch: string): boolean {
	return JAPANESE_CHAR.test(ch);
}

export function splitRuns(text: string): Run[] {
	const runs: Run[] = [];

	for (const ch of text) {
		const japanese = isJapanese(ch);
		const last = runs[runs.length - 1];
		if (last && last.japanese === japanese) last.text += ch;
		else runs.push({ text: ch, japanese });
	}

	return runs;
}

/**
 * Whether a run is worth tokenising at all.
 *
 * A run of nothing but Japanese punctuation -- a stray 。 or 、 left between two
 * English clauses -- carries no reading and would render as an empty clickable
 * span, so it is passed through as plain text instead.
 */
const HAS_WORD = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/u;

export function isReadable(run: Run): boolean {
	return run.japanese && HAS_WORD.test(run.text);
}
