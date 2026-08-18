import type { FuriganaSegment } from './furigana';
import { toRomaji } from './romaji';

/**
 * Turning a mined word into a card someone learning to read can actually use.
 *
 * The first cards this project produced were entirely Japanese -- 「ボク」 on the
 * front, and on the back a reading, a gloss, and the sentence it was met in,
 * still unreadable. A card you cannot read is not a card, it is a reminder that
 * you could not read something.
 *
 * The division of labour here is the whole design, and it runs the other way
 * from "ask the model for everything":
 *
 *   Readings are computed, never generated. Kana, romaji and furigana come from
 *   JMdict and the tokenizer, which are right by construction. A model asked for
 *   a reading will occasionally invent a plausible one, and a wrong reading on a
 *   flashcard is worse than no card at all -- it is drilled until it sticks.
 *
 *   Meaning in context is generated, because nothing else can do it. JMdict
 *   gives 諦める eight senses and no way to know which one this sentence used;
 *   the dictionary cannot tell you that ボク is a boyish first-person that this
 *   girl uses deliberately. That is what the model is for.
 */

/** What the model is asked to supply, and nothing more. */
export type Enrichment = {
	/** The sense that actually applies here, in a few words. */
	meaning: string;
	/** A natural English rendering of the sentence the word was met in. */
	sentence: string;
	/**
	 * The same sentence read structurally, in Japanese order.
	 *
	 * A natural translation tells you what the line meant. It does not tell you
	 * how the Japanese got there, and that is the half you need to read the
	 * *next* line -- 嫌悪の色を宿す arrives as 'harboured a deep-rooted loathing',
	 * which hides that 色 is a tinge and 宿す is to house. Reading both is the
	 * sandwich technique, and for someone decoding rather than producing it is
	 * the useful one.
	 */
	literal: string;
	/** Register, nuance, or why this word is the one used. One or two sentences. */
	note: string;
};

export type SentenceToken = {
	surface: string;
	/** Hiragana reading, or null when the tokenizer had none. */
	reading: string | null;
};

/**
 * Bracket notation, the form Lattice renders as ruby: 食[た]べる.
 *
 * Only kanji runs are annotated. Bracketing kana would put a reading over
 * characters that already are the reading, and Lattice refuses to render those
 * anyway -- the two rules are deliberately the same rule.
 */
export function bracketFurigana(segments: FuriganaSegment[]): string {
	return segments.map((s) => (s.ruby ? `${s.text}[${s.ruby}]` : s.text)).join('');
}

const HAN = /\p{Script=Han}/u;
const KANA_ONLY = /^[\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * Annotate a whole sentence from its tokens.
 *
 * A token contributes a reading only when it contains kanji and the reading
 * differs from the surface. Everything else is passed through untouched, so a
 * sentence of pure kana comes out exactly as it went in.
 */
export function annotateSentence(
	tokens: readonly SentenceToken[],
	align: (surface: string, reading: string | null) => FuriganaSegment[],
	names: readonly NameReading[] = []
): string {
	// Names are matched across tokens before anything else, because the tokenizer
	// gets them wrong and does so confidently. 桜羽 comes back as 桜(さくら) +
	// 羽(わ), so the sentence was annotated 桜[さくら]羽[わ] -- a reading the
	// reader would have learnt off a flashcard, and the wrong one. The name
	// thread already knows it is さくらば, so that wins.
	const known = names.filter((n) => n.reading).sort((a, b) => b.surface.length - a.surface.length);

	const out: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const match = known.find((n) => {
			let span = '';
			for (let j = i; j < tokens.length && span.length < n.surface.length; j++) {
				span += tokens[j].surface;
			}
			return span === n.surface;
		});

		if (match) {
			let span = '';
			let j = i;
			while (j < tokens.length && span.length < match.surface.length) span += tokens[j++].surface;
			out.push(bracketFurigana(align(match.surface, match.reading)));
			i = j - 1;
			continue;
		}

		const t = tokens[i];
		if (!HAN.test(t.surface) || !t.reading || t.reading === t.surface) out.push(t.surface);
		else out.push(bracketFurigana(align(t.surface, t.reading)));
	}

	return out.join('');
}

export type CardDraft = {
	lemma: string;
	front: string;
	back: string;
	tags: string;
};

/**
 * Compose the card.
 *
 * The front is the bare dictionary form. Putting the reading on it would make
 * every card a reading exercise the answer to which is printed on it; the point
 * of recall is that you supply the reading yourself.
 *
 * The dictionary form rather than the form that happened to appear, because a
 * card fronted 待っ or 気安く teaches an inflection as though it were a word,
 * and its romaji comes from the dictionary anyway -- the first cards read
 * `気安く  kiyasui`, which is two different words on one line. The inflected
 * form is still there, in the sentence, where it belongs.
 *
 * The back is ordered by what you need first when you have just failed: what it
 * means, then how it sounds, then the sentence, then why. Lattice preserves the
 * line breaks and renders the brackets as ruby.
 */
export function composeCard(input: {
	/** The dictionary form. This is the front of the card. */
	lemma: string;
	reading: string | null;
	wordSegments: FuriganaSegment[];
	glosses: string[];
	speaker: string | null;
	annotatedSentence: string | null;
	sentenceTranslation: string | null;
	enrichment: Enrichment | null;
	tags?: string;
}): CardDraft {
	const {
		lemma,
		reading,
		wordSegments,
		glosses,
		speaker,
		annotatedSentence,
		sentenceTranslation,
		enrichment
	} = input;

	const lines: string[] = [];

	// The meaning the model picked for this context leads, with the dictionary's
	// own glosses kept underneath rather than replaced -- the model chooses among
	// them, it does not get to overrule them.
	const meaning = enrichment?.meaning?.trim();
	if (meaning) lines.push(meaning);

	const dictionary = glosses.slice(0, 4).join('; ');
	if (dictionary && dictionary !== meaning) lines.push(dictionary);

	// Romaji only when it is actually romaji. toRomaji passes characters it cannot
	// convert straight through, so a word with no recorded reading -- 桜羽エマ has
	// no dictionary entry -- came out as the literal string `桜羽ema`, which is
	// not a pronunciation of anything.
	const romaji = toRomaji(reading && reading !== lemma ? reading : lemma);
	const sound = [bracketFurigana(wordSegments), CJK.test(romaji) ? '' : romaji]
		.filter(Boolean)
		.join('  ');
	if (sound) lines.push('', sound);

	if (annotatedSentence) {
		lines.push('');
		lines.push(speaker ? `${speaker}: ${annotatedSentence}` : annotatedSentence);
		// Structure first, then the natural reading. You have just read the
		// Japanese; the gloss shows how it parses, and the natural line shows what
		// that adds up to. The other order gives away the answer before the work.
		const literal = enrichment?.literal?.trim();
		if (literal) lines.push(`lit. ${literal}`);

		const english = enrichment?.sentence?.trim() || sentenceTranslation?.trim();
		if (english) lines.push(english);
	}

	const note = enrichment?.note?.trim();
	if (note) lines.push('', note);

	return {
		lemma,
		front: lemma,
		back: lines
			.join('\n')
			.replace(/\n{3,}/gu, '\n\n')
			.trim(),
		tags: input.tags ?? 'yomu,manosaba'
	};
}

/**
 * One prompt for the whole batch.
 *
 * Per-word calls would be simpler and are the wrong shape twice over: the model
 * would pay the context rules again for every word, and it would lose the thing
 * that makes a batch worth batching -- these words were met in the same story,
 * often in the same scene, and one of them is frequently the key to another.
 */
export const ENRICH_RULES = `You are preparing vocabulary cards for someone reading a Japanese visual novel.

For each word you are given the word, its dictionary glosses, and the sentence the reader actually met it in.

Rules:
- "meaning" is the sense that applies IN THIS SENTENCE, in a few words. Choose among the glosses given; do not invent a sense they do not support. If the glosses are all wrong for this context, say what it means here anyway and keep it short.
- "sentence" is a natural English rendering of the whole sentence. Natural, not word-for-word — it is there to show what the reader was supposed to get.
- "literal" is the same sentence read structurally, following Japanese order and keeping each word's own sense, so the reader can see how the parts add up to the natural reading. Keep it grammatical enough to follow. Where a word is figurative, use its figurative sense rather than its concrete one — 色 in 嫌悪の色 is a tinge, not a colour — because a gloss that is literal but wrong teaches a wrong analysis, which is the only way this field can do harm.
- "note" is one or two sentences on register, nuance, or why this word rather than a neighbour. Say something specific to this word in this line. If there is genuinely nothing worth saying, use an empty string rather than padding.
- NEVER give readings, kana, romaji or pronunciation for the word itself. Those are computed from the dictionary and yours would compete with them.
- Write character names in the English sentence in romaji, using any reading given to you. Never half-convert a name: 桜羽エマ becomes Sakuraba Ema, never 'Sakura羽 Emma'.
- Do not use double quotes inside any field: the reply is parsed as JSON and a raw double quote inside a string breaks it. Use single quotes.

Spoiler rules, which override the above:
- Use ONLY the story context provided. It is exactly what the reader has already read.
- NEVER refer to anything later in the story. If a word's significance is not yet established, do not establish it.
- Do not draw on outside knowledge of this work.`;

export type EnrichRequestItem = {
	lemma: string;
	surface: string;
	glosses: string[];
	sentence: string | null;
	speaker: string | null;
};

const SCHEMA = {
	type: 'object',
	properties: {
		words: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					lemma: { type: 'string' },
					meaning: { type: 'string' },
					sentence: { type: 'string' },
					literal: { type: 'string' },
					note: { type: 'string' }
				},
				required: ['lemma', 'meaning', 'sentence', 'literal', 'note']
			}
		}
	},
	required: ['words']
};

export type NameReading = { surface: string; reading: string | null };

/**
 * Romanize a character name into parts.
 *
 * The reading is stored for the whole name, so romanizing it directly gives
 * `sakurabaema` -- which is not a name anyone would write. The furigana aligner
 * already knows where 桜羽 stops and エマ starts, so reuse it and romanize each
 * piece: Sakuraba Ema.
 *
 * If alignment cannot split it, the whole reading is romanized as one word.
 * A run-on name is poor; an invented word boundary would be wrong.
 */
export function romanizeName(
	surface: string,
	reading: string,
	align: (s: string, r: string | null) => FuriganaSegment[]
): string {
	const parts = align(surface, reading)
		.map((seg) => toRomaji(seg.ruby ?? seg.text))
		.filter((p) => /[a-z]/iu.test(p));

	const words = parts.length ? parts : [toRomaji(reading)];
	return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export function buildEnrichPrompt(
	items: readonly EnrichRequestItem[],
	context: string,
	names: readonly NameReading[] = [],
	align: (s: string, r: string | null) => FuriganaSegment[] = () => []
): string {
	const words = items
		.map((it, i) =>
			[
				`${i + 1}. ${it.surface}  (lemma: ${it.lemma})`,
				`   glosses: ${it.glosses.length ? it.glosses.slice(0, 6).join('; ') : '(none in the dictionary)'}`,
				`   sentence: ${it.sentence ? (it.speaker ? `${it.speaker}: ${it.sentence}` : it.sentence) : '(not recorded)'}`
			].join('\n')
		)
		.join('\n\n');

	// Names are the one reading the model is handed rather than forbidden, because
	// it needs them to write the English sentence and cannot derive them: 桜羽 is
	// さくらば, not the さくらわ a tokenizer produces. Left to guess, it returned
	// 'Sakura羽 Emma' -- half-converted, and worse than either whole answer.
	const glossary = names
		.filter((n) => n.reading)
		.map((n) => `- ${n.surface} = ${romanizeName(n.surface, n.reading!, align)}`)
		.join('\n');

	return [
		ENRICH_RULES,
		context ? `\n# Story context (everything the reader has read)\n\n${context}` : '',
		glossary ? `\n# Character names, for the English sentence\n\n${glossary}` : '',
		`\n# Words\n\n${words}`,
		`\nReturn one entry per word, keyed by the lemma exactly as given, in a JSON object matching this schema:\n${JSON.stringify(SCHEMA)}`
	].join('\n');
}

/**
 * Read bracket notation back into segments, so the panel can show a draft as
 * the card it will become rather than as the markup it is stored in.
 *
 * Deliberately the same rule Lattice's renderer uses: a reading belongs to the
 * kanji run immediately before it, and must be kana. If the two disagreed, the
 * preview would be a lie in exactly the situation previewing exists for.
 */
export function parseBrackets(text: string): FuriganaSegment[] {
	const segments: FuriganaSegment[] = [];
	let plain = '';

	const flush = () => {
		if (plain) segments.push({ text: plain, ruby: null });
		plain = '';
	};

	for (let i = 0; i < text.length; i++) {
		if (text[i] !== '[') {
			plain += text[i];
			continue;
		}

		const close = text.indexOf(']', i);
		const ruby = close === -1 ? '' : text.slice(i + 1, close);

		let start = plain.length;
		while (start > 0 && HAN.test(plain[start - 1])) start--;

		if (close === -1 || start === plain.length || !KANA_ONLY.test(ruby)) {
			plain += text[i];
			continue;
		}

		const base = plain.slice(start);
		plain = plain.slice(0, start);
		flush();
		segments.push({ text: base, ruby });
		i = close;
	}

	flush();
	return segments;
}

/**
 * Match the model's entries back to the words that were asked about.
 *
 * Keying on the lemma alone loses entries, and loses them silently. The prompt
 * shows both forms -- `1. 待っ  (lemma: 待つ)` -- and the model quite reasonably
 * answers with the one it was shown first, so 待つ, 気安い and 吐く came back
 * unmatched while every word whose lemma equalled its surface matched fine. The
 * cards still went out, just thin, which is the worst way to fail: nothing
 * errored and three cards were quietly worse than the other eight.
 *
 * So: lemma, then surface, then position. Position is last because it is the
 * only one that can match the wrong word, and it is included at all because a
 * model that renames every key still returns them in the order it was asked.
 */
export function matchEnrichments<T extends { lemma: string; surface: string }>(
	asked: readonly T[],
	got: readonly (Enrichment & { lemma?: string })[]
): { matched: Map<string, Enrichment>; unmatched: string[] } {
	const matched = new Map<string, Enrichment>();
	const spare = [...got];

	const take = (predicate: (w: (typeof spare)[number]) => boolean) => {
		const i = spare.findIndex(predicate);
		return i === -1 ? null : spare.splice(i, 1)[0];
	};

	for (const item of asked) {
		const hit =
			take((w) => w.lemma === item.lemma) ?? take((w) => w.lemma === item.surface) ?? null;
		if (hit) matched.set(item.lemma, hit);
	}

	// Anything still unclaimed is handed out in the order it was asked for.
	const leftover = asked.filter((a) => !matched.has(a.lemma));
	if (spare.length && spare.length === leftover.length) {
		leftover.forEach((a, i) => matched.set(a.lemma, spare[i]));
	}

	return {
		matched,
		unmatched: asked.filter((a) => !matched.has(a.lemma)).map((a) => a.lemma)
	};
}
