import { describe, expect, it } from 'vitest';
import { toRomaji } from './romaji';

describe('toRomaji', () => {
	it('handles plain hiragana', () => {
		expect(toRomaji('さくらば')).toBe('sakuraba');
		expect(toRomaji('ろうや')).toBe('rouya');
	});

	it('handles katakana, which is the whole reason this exists', () => {
		expect(toRomaji('ボク')).toBe('boku');
		expect(toRomaji('メルル')).toBe('meruru');
	});

	it('uses Hepburn for the irregular syllables', () => {
		// shi/chi/tsu/fu, not si/ti/tu/hu.
		expect(toRomaji('しちつふ')).toBe('shichitsufu');
	});

	it('handles yōon digraphs', () => {
		expect(toRomaji('きょう')).toBe('kyou');
		expect(toRomaji('しゃしん')).toBe('shashin');
		expect(toRomaji('じゃ')).toBe('ja');
	});

	it('doubles the consonant after a sokuon', () => {
		expect(toRomaji('がっこう')).toBe('gakkou');
		expect(toRomaji('きっぷ')).toBe('kippu');
	});

	it('writes っち as tchi, not cchi', () => {
		expect(toRomaji('まっちゃ')).toBe('matcha');
	});

	it('drops a trailing sokuon rather than doubling nothing', () => {
		// This VN is full of stuttering: っ……！ and ですっ.
		expect(toRomaji('っ')).toBe('');
		expect(toRomaji('ですっ')).toBe('desu');
	});

	it('always writes ん as n, so the romaji maps back to the kana', () => {
		// Traditional Hepburn writes m before b/m/p (shimbun, sampo). Rejected
		// on purpose: this is a kana-recall aid, and "m" teaches the wrong sound
		// for the character actually on screen.
		expect(toRomaji('しんぶん')).toBe('shinbun');
		expect(toRomaji('さんぽ')).toBe('sanpo');
		expect(toRomaji('あんまり')).toBe('anmari');
	});

	it('disambiguates ん before a vowel with an apostrophe', () => {
		// Without it, きんえん reads as ki-ne-n rather than kin-en.
		expect(toRomaji('きんえん')).toBe("kin'en");
		expect(toRomaji('ほんや')).toBe("hon'ya");
	});

	it('repeats the vowel for a prolonged sound mark', () => {
		expect(toRomaji('シェリー')).toBe('sherii');
		expect(toRomaji('ラーメン')).toBe('raamen');
	});

	it('handles the katakana-only combinations loanwords use', () => {
		expect(toRomaji('フィルム')).toBe('firumu');
		expect(toRomaji('チェス')).toBe('chesu');
		expect(toRomaji('ヴァイオリン')).toBe('vaiorin');
	});

	it('converts the real character names from the capture', () => {
		expect(toRomaji('さくらばえま')).toBe('sakurabaema');
		expect(toRomaji('たちばなシェリー')).toBe('tachibanasherii');
		expect(toRomaji('ひかみメルル')).toBe('hikamimeruru');
	});

	it('passes non-kana through instead of mangling it', () => {
		expect(toRomaji('牢屋')).toBe('牢屋');
		expect(toRomaji('ボク！')).toBe('boku！');
	});

	it('returns empty for empty input', () => {
		expect(toRomaji('')).toBe('');
	});
});
