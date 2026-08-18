import { describe, expect, it } from 'vitest';
import {
	annotateSentence,
	bracketFurigana,
	buildEnrichPrompt,
	composeCard,
	ENRICH_RULES,
	matchEnrichments,
	parseBrackets,
	romanizeName
} from './enrich';
import { furigana } from './furigana';

const align = (surface: string, reading: string | null) => furigana(surface, reading);

describe('bracketFurigana', () => {
	it('writes readings in the notation Lattice renders as ruby', () => {
		expect(bracketFurigana(furigana('奥歯', 'オクバ'))).toBe('奥歯[おくば]');
	});

	it('leaves okurigana outside the brackets', () => {
		// 食[た]べる, never 食べる[たべる] -- the same rule the reader's own furigana
		// follows, because a card and the reader must not disagree about a word.
		expect(bracketFurigana(furigana('食べる', 'タベル'))).toBe('食[た]べる');
	});

	it('adds nothing to a word that is already kana', () => {
		expect(bracketFurigana(furigana('ボク', 'ボク'))).toBe('ボク');
	});
});

describe('annotateSentence', () => {
	it('annotates only the tokens that contain kanji', () => {
		const tokens = [
			{ surface: 'ボク', reading: 'ぼく' },
			{ surface: 'は', reading: 'は' },
			{ surface: '諦め', reading: 'あきらめ' },
			{ surface: 'ない', reading: 'ない' }
		];
		expect(annotateSentence(tokens, align)).toBe('ボクは諦[あきら]めない');
	});

	it('passes an all-kana sentence through untouched', () => {
		const tokens = [
			{ surface: 'そう', reading: 'そう' },
			{ surface: 'です', reading: 'です' },
			{ surface: 'ね', reading: 'ね' }
		];
		expect(annotateSentence(tokens, align)).toBe('そうですね');
	});

	it('keeps a token whose reading is missing rather than dropping it', () => {
		// Unknown words are exactly the ones worth studying; losing them from the
		// sentence would quietly delete the interesting half of the card.
		const tokens = [
			{ surface: '桜羽', reading: null },
			{ surface: 'エマ', reading: 'えま' }
		];
		expect(annotateSentence(tokens, align)).toBe('桜羽エマ');
	});
});

describe('composeCard', () => {
	const base = {
		lemma: '諦める',
		reading: 'あきらめる',
		wordSegments: furigana('諦める', 'アキラメル'),
		glosses: ['to give up', 'to abandon'],
		speaker: '桜羽エマ',
		annotatedSentence: 'ボ、ボク諦[あきら]めないから！',
		sentenceTranslation: null,
		enrichment: {
			meaning: 'to give up (on something)',
			sentence: "I-I'm not giving up!",
			literal: 'I-I, because I will not give up!',
			note: 'Negated as 諦めない. She uses ボク, a boyish first person, which reads as bravado here.'
		}
	};

	it('keeps the front a bare word', () => {
		// A reading on the front makes every card a reading exercise with the answer
		// printed on it.
		expect(composeCard(base).front).toBe('諦める');
		expect(composeCard(base).front).not.toContain('[');
	});

	it('carries reading, romaji, sentence and note on the back', () => {
		const back = composeCard(base).back;
		expect(back).toContain('諦[あきら]める');
		expect(back).toContain('akirameru');
		expect(back).toContain('ボ、ボク諦[あきら]めないから！');
		expect(back).toContain("I-I'm not giving up!");
		expect(back).toContain('桜羽エマ');
		expect(back).toContain('boyish first person');
	});

	it('never emits three consecutive newlines', () => {
		// The back is built from optional blocks, and Lattice now renders newlines
		// literally, so a missing block used to leave a visible gap.
		const sparse = composeCard({
			...base,
			glosses: [],
			annotatedSentence: null,
			enrichment: { meaning: 'to give up', sentence: '', literal: '', note: '' }
		});
		expect(sparse.back).not.toMatch(/\n\n\n/u);
		expect(sparse.back.startsWith('\n')).toBe(false);
	});

	it('still produces a usable card with no enrichment at all', () => {
		// Enrichment goes through a provider that can be down. Falling back to the
		// dictionary card is worse than the enriched one and far better than none.
		const bare = composeCard({ ...base, enrichment: null });
		expect(bare.back).toContain('to give up; to abandon');
		expect(bare.back).toContain('諦[あきら]める');
		expect(bare.back).toContain('akirameru');
	});

	it('does not repeat the dictionary line when the model just echoed it', () => {
		const echoed = composeCard({
			...base,
			glosses: ['to give up'],
			enrichment: { meaning: 'to give up', sentence: '', literal: '', note: '' }
		});
		expect(echoed.back.match(/to give up/gu)).toHaveLength(1);
	});

	it('fronts the dictionary form, not the form that happened to appear', () => {
		// The first cards read `気安く  kiyasui` -- the inflected surface above the
		// dictionary form's romaji, which is two different words on one line.
		const card = composeCard({
			...base,
			lemma: '気安い',
			reading: 'きやすい',
			wordSegments: furigana('気安い', 'キヤスイ'),
			glosses: ['friendly'],
			annotatedSentence: '気安[きやす]く触[ふ]れないでほしい。'
		});

		expect(card.front).toBe('気安い');
		expect(card.back).toContain('気安[きやす]い');
		expect(card.back).toContain('kiyasui');
		// The inflected form is still there, in the sentence, where it belongs.
		expect(card.back).toContain('気安[きやす]く');
	});
});

describe('buildEnrichPrompt', () => {
	const items = [
		{
			lemma: '諦める',
			surface: '諦め',
			glosses: ['to give up'],
			sentence: 'ボ、ボク諦めないから！',
			speaker: '桜羽エマ'
		}
	];

	it('gives the model the word, its glosses and the sentence it was met in', () => {
		const p = buildEnrichPrompt(items, '');
		expect(p).toContain('諦め');
		expect(p).toContain('to give up');
		expect(p).toContain('ボ、ボク諦めないから！');
		expect(p).toContain('桜羽エマ');
	});

	it('forbids the model from supplying readings', () => {
		// Readings are computed from JMdict and the tokenizer, which are right by
		// construction. A generated reading that disagrees would be drilled.
		expect(ENRICH_RULES).toMatch(/NEVER give readings/);
	});

	it('carries the spoiler rules', () => {
		expect(buildEnrichPrompt(items, '')).toMatch(/NEVER refer to anything later/);
	});

	it('says so plainly when a word has no dictionary entry', () => {
		const p = buildEnrichPrompt([{ ...items[0], glosses: [] }], '');
		expect(p).toContain('(none in the dictionary)');
	});

	it('batches every word into one prompt', () => {
		const p = buildEnrichPrompt(
			[items[0], { ...items[0], lemma: '奥歯', surface: '奥歯', sentence: 'ぎりっと強く奥歯' }],
			''
		);
		expect(p).toContain('1. 諦め');
		expect(p).toContain('2. 奥歯');
	});
});

describe('parseBrackets', () => {
	it('round-trips what bracketFurigana wrote', () => {
		const segments = furigana('食べる', 'タベル');
		expect(parseBrackets(bracketFurigana(segments))).toEqual(segments);
	});

	it('follows the same rule as the Lattice renderer', () => {
		// If the preview and the renderer disagreed, the preview would be wrong in
		// exactly the situation previewing exists for.
		expect(parseBrackets('see [note 3]')).toEqual([{ text: 'see [note 3]', ruby: null }]);
		expect(parseBrackets('店[1]')).toEqual([{ text: '店[1]', ruby: null }]);
		expect(parseBrackets('奥歯[おくば')).toEqual([{ text: '奥歯[おくば', ruby: null }]);
	});

	it('keeps newlines, which are structure on a card back', () => {
		expect(parseBrackets('諦[あきら]める\nto give up')).toEqual([
			{ text: '諦', ruby: 'あきら' },
			{ text: 'める\nto give up', ruby: null }
		]);
	});
});

describe('what the model is not trusted with', () => {
	// The division of labour is the design, so it is worth asserting rather than
	// only documenting: readings are computed, meaning-in-context is generated.
	const segments = furigana('奥歯', 'オクバ');

	it('uses the computed reading even when the model contradicts it', () => {
		const card = composeCard({
			lemma: '奥歯',
			reading: 'おくば',
			wordSegments: segments,
			glosses: ['back teeth', 'molars'],
			speaker: null,
			annotatedSentence: null,
			sentenceTranslation: null,
			enrichment: {
				meaning: 'back teeth',
				sentence: '',
				literal: '',
				// A model told not to give readings sometimes gives one anyway. It
				// lands in prose, where it is visibly a remark; it can never replace
				// the bracket reading, which is built from the dictionary.
				note: 'Pronounced okuba.'
			}
		});

		expect(card.back).toContain('奥歯[おくば]');
		expect(card.back).toContain('okuba');
	});

	it('falls back to the dictionary when the model returns nothing usable', () => {
		const card = composeCard({
			lemma: '奥歯',
			reading: 'おくば',
			wordSegments: segments,
			glosses: ['back teeth'],
			speaker: null,
			annotatedSentence: null,
			sentenceTranslation: null,
			enrichment: { meaning: '', sentence: '', literal: '', note: '' }
		});

		expect(card.back).toContain('back teeth');
		expect(card.back.trim()).not.toBe('');
	});
});

describe('character names in the prompt', () => {
	it('hands the model the readings it cannot derive', () => {
		// The one reading the model is given rather than forbidden. It needs names
		// to write the English sentence, and 桜羽 is さくらば -- not the さくらわ a
		// tokenizer produces from the characters.
		const p = buildEnrichPrompt(
			[
				{
					lemma: '塞ぐ',
					surface: '塞ぎ',
					glosses: ['to block'],
					sentence: '桜羽エマは耳を塞ぎたかった。',
					speaker: null
				}
			],
			'',
			[
				{ surface: '桜羽エマ', reading: 'さくらばえま' },
				{ surface: '氷上メルル', reading: null }
			],
			align
		);

		expect(p).toContain('桜羽エマ = Sakuraba Ema');
		// A name with no recorded reading is left out rather than guessed at.
		expect(p).not.toContain('氷上メルル =');
	});

	it('forbids the half-converted name it actually produced', () => {
		expect(ENRICH_RULES).toContain('Sakura羽');
	});
});

describe('romanizeName', () => {
	it('splits a name at the boundary the reading implies', () => {
		expect(romanizeName('桜羽エマ', 'さくらばえま', align)).toBe('Sakuraba Ema');
	});

	it('romanizes a name that is already kana as one word', () => {
		expect(romanizeName('ヒロ', 'ひろ', align)).toBe('Hiro');
	});

	it('runs the name together rather than inventing a boundary', () => {
		// Alignment fails when the reading cannot be matched to the characters. A
		// run-on name is poor; a made-up word boundary would be wrong.
		expect(romanizeName('橘', 'たちばなしぇりー', align)).toBe('Tachibanasherii');
	});
});

describe('names beat the tokenizer', () => {
	// The bug this exists for: kuromoji splits 桜羽 into 桜(さくら) + 羽(わ) and is
	// confident about it, so a real card went out reading 桜[さくら]羽[わ]エマ.
	// The name is さくらば. A wrong furigana on a flashcard is drilled.
	const tokens = [
		{ surface: '桜', reading: 'さくら' },
		{ surface: '羽', reading: 'わ' },
		{ surface: 'エマ', reading: 'えま' },
		{ surface: 'は', reading: 'は' },
		{ surface: '耳', reading: 'みみ' }
	];

	it('uses the recorded name reading across the tokens it spans', () => {
		expect(
			annotateSentence(tokens, align, [{ surface: '桜羽エマ', reading: 'さくらばえま' }])
		).toBe('桜羽[さくらば]エマは耳[みみ]');
	});

	it('leaves the tokenizer alone when no name matches', () => {
		expect(
			annotateSentence(tokens, align, [{ surface: '氷上メルル', reading: 'ひかみめるる' }])
		).toBe('桜[さくら]羽[わ]エマは耳[みみ]');
	});

	it('prefers the longest name when several could match', () => {
		// 桜羽 and 桜羽エマ are both recorded. Matching the shorter one first would
		// annotate half the name and leave エマ stranded.
		const names = [
			{ surface: '桜羽', reading: 'さくらば' },
			{ surface: '桜羽エマ', reading: 'さくらばえま' }
		];
		expect(annotateSentence(tokens, align, names)).toBe('桜羽[さくらば]エマは耳[みみ]');
	});

	it('ignores a name with no recorded reading', () => {
		expect(annotateSentence(tokens, align, [{ surface: '桜羽エマ', reading: null }])).toBe(
			'桜[さくら]羽[わ]エマは耳[みみ]'
		);
	});
});

describe('matchEnrichments', () => {
	const asked = [
		{ lemma: '待つ', surface: '待っ' },
		{ lemma: '嫌悪', surface: '嫌悪' },
		{ lemma: '気安い', surface: '気安く' }
	];
	const e = (meaning: string) => ({ meaning, sentence: '', literal: '', note: '' });

	it('matches on the lemma when the model uses it', () => {
		const { matched, unmatched } = matchEnrichments(asked, [
			{ lemma: '待つ', ...e('to wait') },
			{ lemma: '嫌悪', ...e('disgust') },
			{ lemma: '気安い', ...e('familiar') }
		]);
		expect(matched.get('待つ')?.meaning).toBe('to wait');
		expect(unmatched).toEqual([]);
	});

	it('matches on the surface when the model echoes that instead', () => {
		// The real failure: three of eleven cards went out thin because the model
		// answered with 待っ, the form the prompt showed it first.
		const { matched, unmatched } = matchEnrichments(asked, [
			{ lemma: '待っ', ...e('to wait') },
			{ lemma: '嫌悪', ...e('disgust') },
			{ lemma: '気安く', ...e('familiar') }
		]);
		expect(matched.get('待つ')?.meaning).toBe('to wait');
		expect(matched.get('気安い')?.meaning).toBe('familiar');
		expect(unmatched).toEqual([]);
	});

	it('falls back to position when the keys are useless', () => {
		const { matched } = matchEnrichments(asked, [
			{ lemma: '1', ...e('to wait') },
			{ lemma: '2', ...e('disgust') },
			{ lemma: '3', ...e('familiar') }
		]);
		expect(matched.get('気安い')?.meaning).toBe('familiar');
	});

	it('refuses to guess by position when the counts disagree', () => {
		// Position is the only rule that can match the wrong word, so it only runs
		// when every remaining entry lines up with every remaining question.
		const { matched, unmatched } = matchEnrichments(asked, [{ lemma: '???', ...e('to wait') }]);
		expect(matched.size).toBe(0);
		expect(unmatched).toEqual(['待つ', '嫌悪', '気安い']);
	});

	it('never hands the same entry to two words', () => {
		const dup = [
			{ lemma: '嫌悪', surface: '嫌悪' },
			{ lemma: '嫌悪', surface: '嫌悪' }
		];
		const { matched } = matchEnrichments(dup, [{ lemma: '嫌悪', ...e('disgust') }]);
		expect(matched.size).toBe(1);
	});
});

describe('the literal gloss', () => {
	it('shows the structure above the natural reading', () => {
		// A natural translation says what the line meant. It does not say how the
		// Japanese got there, and that is the half you need for the next line.
		const card = composeCard({
			lemma: '宿す',
			reading: 'やどす',
			wordSegments: furigana('宿す', 'ヤドス'),
			glosses: ['to house', 'to harbour'],
			speaker: null,
			annotatedSentence: '瞳[ひとみ]は、根深[ねぶか]い嫌悪[けんお]の色[いろ]を宿[やど]していた。',
			sentenceTranslation: null,
			enrichment: {
				meaning: 'to harbour (an emotion)',
				sentence: "Hiro's eyes harboured a deep-rooted loathing.",
				literal: 'The eyes were housing the tinge of a deep-rooted loathing.',
				note: ''
			}
		});

		const back = card.back.split('\n');
		const jp = back.findIndex((l) => l.includes('瞳'));
		expect(back[jp + 1]).toBe('lit. The eyes were housing the tinge of a deep-rooted loathing.');
		expect(back[jp + 2]).toBe("Hiro's eyes harboured a deep-rooted loathing.");
	});

	it('is dropped rather than labelled empty', () => {
		const card = composeCard({
			lemma: '宿す',
			reading: 'やどす',
			wordSegments: furigana('宿す', 'ヤドス'),
			glosses: ['to house'],
			speaker: null,
			annotatedSentence: '瞳[ひとみ]は',
			sentenceTranslation: null,
			enrichment: { meaning: 'to harbour', sentence: 'The eyes.', literal: '', note: '' }
		});
		expect(card.back).not.toContain('lit.');
	});

	it('tells the model that a wrong literal is the only way it can do harm', () => {
		expect(ENRICH_RULES).toMatch(/figurative sense rather than its concrete one/);
		expect(ENRICH_RULES).toMatch(/teaches a wrong analysis/);
	});
});

describe('romaji that is not romaji', () => {
	it('drops the romaji rather than printing kanji in it', () => {
		// 桜羽エマ has no JMdict entry, so with no reading toRomaji passed the kanji
		// straight through and the card read `桜羽エマ  桜羽ema`, which is not a
		// pronunciation of anything.
		const card = composeCard({
			lemma: '桜羽エマ',
			reading: null,
			wordSegments: furigana('桜羽エマ', null),
			glosses: [],
			speaker: null,
			annotatedSentence: null,
			sentenceTranslation: null,
			enrichment: null
		});
		expect(card.back).not.toContain('桜羽ema');
	});

	it('keeps the romaji once a reading is known', () => {
		const card = composeCard({
			lemma: '桜羽エマ',
			reading: 'さくらばえま',
			wordSegments: furigana('桜羽エマ', 'サクラバエマ'),
			glosses: [],
			speaker: null,
			annotatedSentence: null,
			sentenceTranslation: null,
			enrichment: null
		});
		expect(card.back).toContain('sakurabaema');
	});
});
