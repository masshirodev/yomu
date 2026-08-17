import * as kuromoji from '@patdx/kuromoji';
import { furigana, toHiragana, type FuriganaSegment } from './furigana';

/**
 * Morphological analysis, in the browser.
 *
 * This runs client-side on purpose. The machine playing the game has cores to
 * spare; the 4-vCPU VPS running two dozen containers does not, and tokenising
 * every line server-side would put the reader's latency on the critical path of
 * everything else hosted there.
 */

export type Token = {
	surface: string;
	/** Dictionary form, the key the known-word model counts against. */
	lemma: string;
	/** Hiragana. kuromoji reports katakana, or nothing for unknown words. */
	reading: string | null;
	pos: string;
	segments: FuriganaSegment[];
	/** Punctuation and symbols are never looked up or counted. */
	lookupable: boolean;
};

const DICT_PATH = '/dict/';

const GZIP_MAGIC = [0x1f, 0x8b];

/**
 * kuromoji asks for `foo.dat.gz`, and whether those bytes arrive still
 * compressed depends on who is serving them.
 *
 * adapter-node serves static files through sirv, which sees the `.gz`
 * extension and sets `Content-Encoding: gzip`, so fetch transparently inflates
 * and hands back plain data. Vite's dev server does not. Decompressing
 * unconditionally therefore works in dev and fails in production with an opaque
 * AbortError, which is exactly how this was found.
 *
 * So sniff the gzip magic number instead of trusting either the extension or
 * the server. It costs one byte comparison and survives any host.
 */
export async function maybeGunzip(raw: ArrayBuffer): Promise<ArrayBufferLike> {
	const head = new Uint8Array(raw, 0, Math.min(2, raw.byteLength));
	if (head[0] !== GZIP_MAGIC[0] || head[1] !== GZIP_MAGIC[1]) return raw;

	const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
	return await new Response(stream).arrayBuffer();
}

const loader: kuromoji.LoaderConfig = {
	async loadArrayBuffer(url: string): Promise<ArrayBufferLike> {
		const res = await fetch(DICT_PATH + url);
		if (!res.ok) throw new Error(`dictionary fetch failed: ${url} (${res.status})`);
		return maybeGunzip(await res.arrayBuffer());
	}
};

// The package declares Tokenizer but does not export it, so derive the type from
// what the builder resolves to rather than reaching into its internals.
type Tokenizer = Awaited<ReturnType<kuromoji.TokenizerBuilder['build']>>;

let building: Promise<Tokenizer> | null = null;

/**
 * Build once, lazily. The dictionary is ~18MB and takes real time to parse, so
 * it must never be loaded during SSR or eagerly on page load.
 */
export function loadTokenizer(): Promise<Tokenizer> {
	if (typeof window === 'undefined') {
		return Promise.reject(new Error('tokenizer is browser-only'));
	}
	building ??= new kuromoji.TokenizerBuilder({ loader }).build();
	return building;
}

// 記号 is punctuation and symbols; 補助記号 appears for some marks. Neither is a
// word, and letting them into the click surface would pollute the friction log
// with 「 and 。 -- which would then rank as vocabulary worth studying.
const IGNORED_POS = new Set(['記号', '補助記号']);

function isLookupable(surface: string, pos: string): boolean {
	if (IGNORED_POS.has(pos)) return false;
	// Whitespace-only surfaces come back for the ideographic space.
	return (
		/\S/u.test(surface) && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(surface)
	);
}

export function toTokens(raw: kuromoji.IpadicFeatures[]): Token[] {
	return raw.map((t) => {
		// kuromoji uses '*' for "no data", including for the base form of words it
		// could not analyse. Fall back to the surface so the lemma is never '*'.
		const lemma = t.basic_form && t.basic_form !== '*' ? t.basic_form : t.surface_form;
		const reading = t.reading && t.reading !== '*' ? toHiragana(t.reading) : null;

		return {
			surface: t.surface_form,
			lemma,
			reading,
			pos: t.pos,
			segments: furigana(t.surface_form, t.reading),
			lookupable: isLookupable(t.surface_form, t.pos)
		};
	});
}

export async function tokenize(text: string): Promise<Token[]> {
	const tokenizer = await loadTokenizer();
	return toTokens(tokenizer.tokenize(text));
}
