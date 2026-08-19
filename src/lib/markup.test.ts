import { describe, expect, it } from 'vitest';
import { cleanMarkup } from './markup';

const clean = (s: string) => cleanMarkup(s).text;
const ruby = (s: string) => cleanMarkup(s).ruby;

describe('control codes', () => {
	it('strips pause codes and keeps the dashes they sit between', () => {
		expect(clean('年齢は俺より２つ下%p-1;─%p;─１６歳の女子高生なので')).toBe(
			'年齢は俺より２つ下──１６歳の女子高生なので'
		);
	});

	it('keeps the text inside a colour span', () => {
		expect(clean('通称“#ff8A00;ラジ館%r”。')).toBe('通称“ラジ館”。');
	});

	it('turns a literal backslash-n into a real break', () => {
		expect(clean('ラジ館”。\\nその８階は')).toBe('ラジ館”。\nその８階は');
	});

	it('does not eat the game title, which contains a semicolon', () => {
		// %C has no terminator, so a general %\w+; rule matches %CSTEINS; and
		// swallows the title. This is the reason bare codes are listed by name.
		expect(clean('%CSTEINS;GATE RE:BOOT ゲームデータを')).toBe(
			'STEINS;GATE RE:BOOT ゲームデータを'
		);
	});

	it('leaves an unknown code visible rather than guessing at it', () => {
		// A code left in is a bug report. One that silently swallowed text is not.
		expect(clean('あれ%zz;これ')).toContain('%zz;');
	});
});

describe('ruby, joined across the run', () => {
	it('reads a name the engine split wrongly', () => {
		// Per character the engine gives 凶=きょ and 真=うま. Both are wrong; the
		// concatenation ほうおういんきょうま is right.
		const r = ruby('“[ほう]鳳[おう]凰[いん]院[きょ]凶[うま]真”');
		expect(r).toEqual([{ base: '鳳凰院凶真', reading: 'ほうおういんきょうま' }]);
		expect(clean('“[ほう]鳳[おう]凰[いん]院[きょ]凶[うま]真”')).toBe('“鳳凰院凶真”');
	});

	it('handles the run written with brackets after the character instead', () => {
		// 牧[まき]瀬[せく] rather than [まき]牧[せく]瀬. The engine is inconsistent
		// about which side the bracket goes, which is a second reason never to
		// pair a bracket with one character.
		expect(ruby('牧[まき]瀬[せく]紅[りす]莉栖だ。')).toEqual([
			{ base: '牧瀬紅莉栖', reading: 'まきせくりす' }
		]);
		expect(clean('牧[まき]瀬[せく]紅[りす]莉栖だ。')).toBe('牧瀬紅莉栖だ。');
	});

	it('reads ダル correctly, where two of three characters are mis-split', () => {
		expect(ruby('[はし]橋[だい]田[たる]至が')).toEqual([
			{ base: '橋田至', reading: 'はしだいたる' }
		]);
	});

	it('handles a single character and a two character run', () => {
		expect(ruby('『[らい]雷ネット')).toEqual([{ base: '雷', reading: 'らい' }]);
		expect(ruby('俺の[ま]真[な]名なのだ。')).toEqual([{ base: '真名', reading: 'まな' }]);
		expect(ruby('[こん]金[りん]輪[ざい]際、')).toEqual([
			{ base: '金輪際', reading: 'こんりんざい' }
		]);
	});

	it('takes the spanning form as N+1 characters', () => {
		expect(ruby('それに、[おかべりんたろう,4]岡部倫太郎と１文字も')).toEqual([
			{ base: '岡部倫太郎', reading: 'おかべりんたろう' }
		]);
		expect(clean('それに、[おかべりんたろう,4]岡部倫太郎と')).toBe('それに、岡部倫太郎と');
	});

	it('spans across kana inside the base', () => {
		// 運命石の扉 is five characters including の, so a kanji-run rule would
		// stop at 運命石. The count is what makes this one work.
		expect(ruby('まゆりには、[シュタインズゲート,4]運命石の扉の鍵という')).toEqual([
			{ base: '運命石の扉', reading: 'シュタインズゲート' }
		]);
	});

	it('leaves a bracket alone when it is not a kana reading', () => {
		// Decks and prose use square brackets for other things.
		expect(clean('チェックは[要確認]だ')).toBe('チェックは[要確認]だ');
		expect(ruby('チェックは[要確認]だ')).toEqual([]);
	});

	it('leaves ordinary text untouched', () => {
		const plain = '俺自身があまり気に入っていないあだ名というヤツだ。';
		expect(clean(plain)).toBe(plain);
		expect(ruby(plain)).toEqual([]);
	});
});
