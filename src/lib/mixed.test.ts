import { describe, expect, it } from 'vitest';
import { isReadable, splitRuns } from './mixed';

const shape = (text: string) => splitRuns(text).map((r) => `${r.japanese ? 'JP' : 'EN'}:${r.text}`);

describe('splitRuns', () => {
	it('splits a real explanation into English and Japanese runs', () => {
		// The exact sentence that exposed this gap: the Japanese in it was
		// unreadable, which made the explanation useless.
		expect(shape('Negative form of 諦める (to give up).')).toEqual([
			'EN:Negative form of ',
			'JP:諦める',
			'EN: (to give up).'
		]);
	});

	it('keeps quoted Japanese together rather than splitting on the brackets', () => {
		expect(shape('The 「諦める」 here')).toEqual(['EN:The ', 'JP:「諦める」', 'EN: here']);
	});

	it('keeps a trailing Japanese full stop with its run', () => {
		expect(shape('as in 行った。 which')).toEqual(['EN:as in ', 'JP:行った。', 'EN: which']);
	});

	it('handles text that is entirely Japanese', () => {
		expect(shape('諦めない')).toEqual(['JP:諦めない']);
	});

	it('handles text with no Japanese at all', () => {
		expect(shape('plain english only')).toEqual(['EN:plain english only']);
	});

	it('does not treat latin letters between kanji as Japanese', () => {
		expect(shape('是N5是')).toEqual(['JP:是', 'EN:N5', 'JP:是']);
	});

	it('handles several Japanese runs in one sentence', () => {
		expect(shape('ない is negative, ぬ is archaic')).toEqual([
			'JP:ない',
			'EN: is negative, ',
			'JP:ぬ',
			'EN: is archaic'
		]);
	});

	it('returns nothing for empty input', () => {
		expect(splitRuns('')).toEqual([]);
	});
});

describe('isReadable', () => {
	it('accepts a run containing kana or kanji', () => {
		expect(isReadable({ text: '諦める', japanese: true })).toBe(true);
		expect(isReadable({ text: 'ない', japanese: true })).toBe(true);
	});

	it('rejects a run of bare Japanese punctuation', () => {
		// A stray 。 between two English clauses has no reading, and tokenising it
		// would render an empty clickable span.
		expect(isReadable({ text: '。', japanese: true })).toBe(false);
		expect(isReadable({ text: '、　', japanese: true })).toBe(false);
	});

	it('rejects English runs outright', () => {
		expect(isReadable({ text: 'hello', japanese: false })).toBe(false);
	});
});
