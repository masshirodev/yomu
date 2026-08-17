import { describe, expect, it } from 'vitest';
import { furigana, toHiragana } from './furigana';

/** Compact rendering so expectations read like the thing they describe. */
const render = (surface: string, reading: string | null) =>
	furigana(surface, reading)
		.map((s) => (s.ruby ? `${s.text}[${s.ruby}]` : s.text))
		.join('');

describe('toHiragana', () => {
	it('converts katakana and leaves everything else alone', () => {
		expect(toHiragana('タベル')).toBe('たべる');
		expect(toHiragana('サクラバエマ')).toBe('さくらばえま');
		expect(toHiragana('シェリー')).toBe('しぇりー');
	});
});

describe('furigana', () => {
	it('attaches the reading to the kanji only, not the okurigana', () => {
		// The whole point of the module.
		expect(render('食べる', 'タベル')).toBe('食[た]べる');
	});

	it('handles two kanji runs split by okurigana', () => {
		expect(render('食べ物', 'タベモノ')).toBe('食[た]べ物[もの]');
	});

	it('rubies a wholly-kanji word in one span', () => {
		expect(render('人生', 'ジンセイ')).toBe('人生[じんせい]');
		expect(render('名探偵', 'メイタンテイ')).toBe('名探偵[めいたんてい]');
	});

	it('leaves a katakana tail without ruby', () => {
		// A real name from the capture. エマ needs no help; 桜羽 does.
		expect(render('桜羽エマ', 'サクラバエマ')).toBe('桜羽[さくらば]エマ');
	});

	it('does not ruby a leading kana prefix', () => {
		expect(render('お茶', 'オチャ')).toBe('お茶[ちゃ]');
	});

	it('handles kanji surrounded by kana on both sides', () => {
		expect(render('見開かれて', 'ミヒラカレテ')).toBe('見開[みひら]かれて');
	});

	it('returns text unchanged when there is no kanji', () => {
		expect(render('ボク', 'ボク')).toBe('ボク');
		expect(render('わわわ', 'ワワワ')).toBe('わわわ');
	});

	it('returns text unchanged for an unknown reading', () => {
		// kuromoji reports '*' for words it cannot analyse.
		expect(render('魔女裁判', '*')).toBe('魔女裁判');
		expect(render('魔女裁判', null)).toBe('魔女裁判');
	});

	it('gives up rather than guess when reading and surface disagree', () => {
		// Wrong furigana actively teaches a wrong reading, so ambiguity must fail
		// towards showing none at all.
		expect(render('食べる', 'ゼンゼンチガウ')).toBe('食べる');
	});

	it('gives up when the reading runs out before the surface does', () => {
		expect(render('食べ物', 'タベ')).toBe('食べ物');
	});

	it('requires a kanji run to consume at least one kana', () => {
		// Naive indexOf would match べ at position 0 and give 食 an empty reading.
		const segments = furigana('食べる', 'タベル');
		expect(segments[0]).toEqual({ text: '食', ruby: 'た' });
	});

	it('handles a real narration fragment', () => {
		expect(render('鉄格子', 'テツゴウシ')).toBe('鉄格子[てつごうし]');
		expect(render('石壁', 'イシカベ')).toBe('石壁[いしかべ]');
	});
});
