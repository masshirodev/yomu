import { describe, expect, it, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import * as kuromoji from '@patdx/kuromoji';
import { toTokens, type Token } from './tokenize';

/**
 * Integration test: real kuromoji output through the real furigana alignment,
 * on real lines from the Phase 0 captures.
 *
 * The unit tests in furigana.test.ts feed readings by hand, which proves the
 * algorithm but not that kuromoji supplies what the algorithm expects. This
 * closes that gap -- it is the only test that would catch, say, kuromoji
 * reporting readings in a form the aligner cannot match.
 *
 * Skipped when the dictionary has not been synced, since it is ~18MB and
 * deliberately not committed. Run `yarn sync:dict` first.
 */
const DICT = join(process.cwd(), 'static', 'dict');
const available = existsSync(join(DICT, 'base.dat.gz'));

// The browser loader fetches and inflates via DecompressionStream. Here the same
// files come off disk, so this exercises the dictionary itself, not the transport.
const nodeLoader: kuromoji.LoaderConfig = {
	async loadArrayBuffer(url: string) {
		const buf = gunzipSync(readFileSync(join(DICT, url)));
		return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	}
};

describe.skipIf(!available)('tokenize against real capture lines', () => {
	let analyse: (text: string) => Token[];

	beforeAll(async () => {
		const tokenizer = await new kuromoji.TokenizerBuilder({ loader: nodeLoader }).build();
		analyse = (text: string) => toTokens(tokenizer.tokenize(text));
	}, 120_000);

	const render = (text: string) =>
		analyse(text)
			.flatMap((t) => t.segments)
			.map((s) => (s.ruby ? `${s.text}[${s.ruby}]` : s.text))
			.join('');

	it('produces okurigana-aware furigana for a real narration line', () => {
		// From raw-20260816-211631.tsv.
		const out = render('室内は薄暗く、空気が澱んでいる。');
		expect(out).toContain('室内[しつない]');
		// The 暗 in 薄暗く must not swallow the く.
		expect(out).toContain('く、');
		expect(out).not.toContain('薄暗く[');
	});

	it('never attaches ruby to trailing kana', () => {
		for (const seg of analyse('エマは促されて、ハッと姿勢を正す。').flatMap((t) => t.segments)) {
			if (seg.ruby) {
				// A ruby'd segment must contain a kanji -- never bare kana.
				expect(seg.text).toMatch(/\p{Script=Han}/u);
			}
		}
	});

	it('marks punctuation as not lookupable', () => {
		const tokens = analyse('ろ、牢屋……！？ なんで！？');
		const punctuation = tokens.filter((t) => /^[、。！？…\s]+$/u.test(t.surface));
		expect(punctuation.length).toBeGreaterThan(0);
		expect(punctuation.every((t) => !t.lookupable)).toBe(true);
	});

	it('gives every lookupable token a usable lemma', () => {
		// '*' leaking into a lemma would corrupt the known-word model silently.
		for (const t of analyse('メルルは今にも泣き出しそうになりながら、膝立ちになった。')) {
			if (t.lookupable) expect(t.lemma).not.toBe('*');
		}
	});

	it('reads a kanji compound the reader will actually meet', () => {
		expect(render('鉄格子')).toBe('鉄格子[てつごうし]');
	});
});

/**
 * kuromoji's basic_form is what makes a separate deinflection layer unnecessary:
 * a conjugated surface already arrives with its dictionary form attached, which
 * is the key JMdict is indexed by.
 */
describe.skipIf(!available)('lemmas are dictionary forms', () => {
	let analyse: (text: string) => Token[];

	beforeAll(async () => {
		const tokenizer = await new kuromoji.TokenizerBuilder({ loader: nodeLoader }).build();
		analyse = (text: string) => toTokens(tokenizer.tokenize(text));
	}, 120_000);

	const lemmaOf = (text: string, surface: string) =>
		analyse(text).find((t) => t.surface === surface)?.lemma;

	it('reduces a conjugated verb to the form JMdict is keyed by', () => {
		// From the capture: 見開かれて -> 見開く, which is the entry that exists.
		expect(lemmaOf('その眼がみるみる見開かれていく。', '見開か')).toBe('見開く');
	});

	it('reduces a passive-past chain', () => {
		expect(lemmaOf('蔑まれ、貶められ、嘲笑される毎日に、', '蔑ま')).toBe('蔑む');
	});
});
