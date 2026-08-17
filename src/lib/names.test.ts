import { describe, expect, it } from 'vitest';
import { applyNames, type NameEntry } from './names';
import type { Token } from './tokenize';
import { furigana } from './furigana';

/** Stand-in for kuromoji output; only the fields applyNames touches matter. */
const tok = (surface: string, reading: string | null = null): Token => ({
	surface,
	lemma: surface,
	reading,
	pos: '名詞',
	segments: furigana(surface, reading),
	lookupable: true
});

const render = (tokens: Token[]) =>
	tokens
		.flatMap((t) => t.segments)
		.map((s) => (s.ruby ? `${s.text}[${s.ruby}]` : s.text))
		.join('');

describe('applyNames', () => {
	const names: NameEntry[] = [
		{ surface: '桜羽エマ', reading: 'さくらばえま' },
		{ surface: '桜羽', reading: 'さくらば' },
		{ surface: '氷上メルル', reading: 'ひかみめるる' }
	];

	it('merges the split kuromoji produces for an unknown surname', () => {
		// The actual failure: 桜羽 comes back as 桜[さくら] + 羽[わ].
		const tokens = [tok('桜', 'さくら'), tok('羽', 'わ'), tok('は')];
		const out = applyNames(tokens, names);

		expect(out[0].surface).toBe('桜羽');
		expect(out[0].reading).toBe('さくらば');
		expect(render(out)).toBe('桜羽[さくらば]は');
	});

	it('prefers the longest name so the full name is not lost to the surname', () => {
		const tokens = [tok('桜'), tok('羽'), tok('エマ')];
		const out = applyNames(tokens, names);

		expect(out).toHaveLength(1);
		expect(out[0].surface).toBe('桜羽エマ');
		expect(out[0].reading).toBe('さくらばえま');
	});

	it('leaves surrounding tokens untouched', () => {
		const tokens = [tok('ボク'), tok('は'), tok('桜'), tok('羽'), tok('エマ'), tok('！')];
		const out = applyNames(tokens, names);

		expect(out.map((t) => t.surface)).toEqual(['ボク', 'は', '桜羽エマ', '！']);
	});

	it('does not match a name that would end mid-token', () => {
		// 桜羽 cannot be carved out of a single 桜羽子 token without splitting a word
		// kuromoji actually analysed, which would be worse than not matching.
		const tokens = [tok('桜羽子')];
		expect(applyNames(tokens, names)).toEqual(tokens);
	});

	it('merges a name whose reading is not yet filled in', () => {
		const tokens = [tok('氷'), tok('上'), tok('メルル')];
		const out = applyNames(tokens, [{ surface: '氷上メルル', reading: null }]);

		expect(out[0].surface).toBe('氷上メルル');
		expect(out[0].reading).toBeNull();
		// No ruby without a reading, but still one clickable unit.
		expect(render(out)).toBe('氷上メルル');
	});

	it('is a no-op with no names', () => {
		const tokens = [tok('桜'), tok('羽')];
		expect(applyNames(tokens, [])).toEqual(tokens);
	});

	it('handles a name at the very end of a line', () => {
		const tokens = [tok('は'), tok('桜'), tok('羽')];
		expect(applyNames(tokens, names).map((t) => t.surface)).toEqual(['は', '桜羽']);
	});
});
