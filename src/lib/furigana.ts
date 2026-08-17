/**
 * Okurigana-aware furigana alignment.
 *
 * A morphological analyser hands back a whole-word reading: 食べる -> タベル. Ruby
 * placed naively spans the entire word, giving 食べる[たべる], which is wrong and
 * looks it -- the kana are already readable, and covering them buries the one
 * character the reader actually needed help with. The correct result attaches the
 * reading to the kanji run only:
 *
 *     食[た]べる          not  食べる[たべる]
 *     食[た]べ物[もの]     not  食べ物[たべもの]
 *     桜羽[さくらば]エマ   not  桜羽エマ[さくらばえま]
 *
 * This module is deliberately independent of the tokenizer. It takes a surface
 * and a reading and nothing else, so swapping kuromoji for lindera or anything
 * else later changes no logic here.
 */

export type FuriganaSegment = {
	text: string;
	/** Hiragana reading, or null when the segment needs no ruby. */
	ruby: string | null;
};

const KATAKANA_START = 0x30a1;
const KATAKANA_END = 0x30f6;
const KANA_OFFSET = 0x60;

/** Katakana to hiragana, leaving everything else (ー, ヶ, punctuation) untouched. */
export function toHiragana(text: string): string {
	let out = '';
	for (const ch of text) {
		const code = ch.codePointAt(0)!;
		out +=
			code >= KATAKANA_START && code <= KATAKANA_END
				? String.fromCodePoint(code - KANA_OFFSET)
				: ch;
	}
	return out;
}

/**
 * Kana for alignment purposes. ー is deliberately included: it is not itself a
 * sound, but it occupies one position in a reading and must line up.
 */
function isKana(ch: string): boolean {
	const c = ch.codePointAt(0)!;
	return (
		(c >= 0x3041 && c <= 0x3096) || // hiragana
		(c >= 0x30a1 && c <= 0x30fa) || // katakana
		c === 0x30fc || // ー prolonged sound mark
		c === 0x3005 // 々 iteration mark, reads as the preceding kanji
	);
}

function hasKanji(text: string): boolean {
	return [...text].some((ch) => !isKana(ch) && /\p{Script=Han}/u.test(ch));
}

type Run = { text: string; kana: boolean };

/** Split a surface into alternating kana and non-kana runs. */
function runs(surface: string): Run[] {
	const out: Run[] = [];
	for (const ch of surface) {
		const kana = isKana(ch);
		const last = out[out.length - 1];
		if (last && last.kana === kana) last.text += ch;
		else out.push({ text: ch, kana });
	}
	return out;
}

/**
 * Align a surface against its reading.
 *
 * Returns the surface as a single unruby'd segment whenever alignment cannot be
 * done confidently. Showing no furigana is a small loss; showing furigana
 * attached to the wrong characters actively teaches the wrong reading, so every
 * ambiguous case fails in that direction on purpose.
 */
export function furigana(surface: string, reading: string | null | undefined): FuriganaSegment[] {
	const plain = [{ text: surface, ruby: null }];

	// Unknown words come back from kuromoji with '*' rather than a reading.
	if (!surface || !reading || reading === '*') return plain;
	if (!hasKanji(surface)) return plain;

	const target = toHiragana(reading);
	const parts = runs(surface);

	// The whole surface is kanji: the reading belongs to all of it.
	if (parts.length === 1) return [{ text: surface, ruby: target }];

	const segments: FuriganaSegment[] = [];
	let cursor = 0;

	for (let i = 0; i < parts.length; i++) {
		const run = parts[i];

		if (run.kana) {
			// A kana run must appear verbatim in the reading. Skip it and move on;
			// its position was already used to bound the preceding kanji run.
			const norm = toHiragana(run.text);
			if (target.startsWith(norm, cursor)) {
				cursor += norm.length;
				segments.push({ text: run.text, ruby: null });
				continue;
			}
			// Reading and surface disagree -- give up rather than guess.
			return plain;
		}

		// A kanji run ends where the next kana run begins in the reading. Search
		// from cursor + 1 because a kanji run must consume at least one kana.
		const next = parts[i + 1];
		if (!next) {
			// Trailing kanji run takes whatever reading is left.
			const rest = target.slice(cursor);
			if (rest.length === 0) return plain;
			segments.push({ text: run.text, ruby: rest });
			cursor = target.length;
			continue;
		}

		const anchor = toHiragana(next.text);
		const found = target.indexOf(anchor, cursor + 1);
		if (found === -1) return plain;

		segments.push({ text: run.text, ruby: target.slice(cursor, found) });
		cursor = found;
	}

	// Every character of the reading must have been accounted for.
	return cursor === target.length ? segments : plain;
}
