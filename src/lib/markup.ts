/**
 * Engine markup, stripped per work.
 *
 * manosaba emitted clean text and Phase 0 concluded no cleanup layer was
 * needed. That was true of manosaba and false in general: Steins;Gate Re:boot
 * carries pause codes, colour spans, literal line breaks and ruby, and left in
 * they would be tokenised as vocabulary and ranked in the mining queue.
 *
 * Dialects are per work because the markup belongs to the engine, not to yomu.
 */

export type Dialect = 'none' | 'sciadv';

/** A reading the game itself supplied, which beats anything computed. */
export type GameRuby = { base: string; reading: string };

export type Cleaned = { text: string; ruby: GameRuby[] };

const KANA = /^[ぁ-ゟ゠-ヿー]+$/u;

/**
 * Ruby, and the reason it cannot be taken one character at a time.
 *
 * The engine writes a run as either `[ほう]鳳[おう]凰` or `牧[まき]瀬[せく]` --
 * the brackets come before their character in some names and after it in
 * others -- and either way the split across characters is wrong: 凶 is given
 * きょ when it reads きょう, 至 is given たる when it reads いたる, 瀬 is given
 * せく when it reads せ.
 *
 * Concatenating the whole run fixes all of it. 鳳凰院凶真 reads
 * ほうおういんきょうま, 橋田至 reads はしだいたる, 牧瀬紅莉栖 reads
 * まきせくりす -- correct in every sample seen, which is the opposite of the
 * per-character pairing being correct in any of them. So a run is one reading
 * over one base, and the direction never has to be decided.
 */
function takeRubyRun(
	text: string,
	at: number
): { base: string; reading: string; end: number } | null {
	const piece = /\[([^[\]]+)\]|([\p{Script=Han}々]+)/uy;
	let i = at;
	let base = '';
	let reading = '';
	let sawBracket = false;

	for (;;) {
		piece.lastIndex = i;
		const m = piece.exec(text);
		if (!m) break;

		if (m[1] !== undefined) {
			// A bracket that is not a kana reading is not ruby -- it is text.
			if (!KANA.test(m[1])) break;
			sawBracket = true;
			reading += m[1];
		} else {
			base += m[2];
		}
		i = m.index + m[0].length;
	}

	if (!sawBracket || !base || !reading) return null;
	return { base, reading, end: i };
}

/**
 * Spanning ruby: `[おかべりんたろう,4]岡部倫太郎`.
 *
 * The number is one less than the characters it covers in every sample seen --
 * always 4, always over a five-character base -- so it is read as an offset and
 * the span is N+1. With no varying sample this is an assumption, and a
 * deliberately visible one: a wrong span shows up as furigana over the wrong
 * characters the moment the line is read.
 */
const SPANNING = /\[([^[\],]+),(\d+)\]/u;

const CODES: [RegExp, string][] = [
	// Pause and timing. `%p-1;─%p;─` is two dashes with codes between them.
	[/%p-?\d*;/gu, ''],
	// Colour spans: `#ff8A00;text%r` keeps the text and drops both ends.
	[/#[0-9a-fA-F]{6};/gu, ''],
	[/%r/gu, ''],
	// A literal backslash-n, which is a line break in the script.
	[/\\n/gu, '\n']
];

/**
 * `%C` carries no terminator, and the game's own title contains a semicolon.
 *
 * `%CSTEINS;GATE` against a general `%\w+;` matches `%CSTEINS;` and eats the
 * title. Terminator-less codes are therefore listed rather than pattern
 * matched, which is also why there is no catch-all rule here: an unknown code
 * left visible is a bug report, and one that silently swallowed text is not.
 */
const BARE_CODES = /%[CcNn](?![a-z0-9])/gu;

export function cleanMarkup(raw: string, dialect: Dialect = 'sciadv'): Cleaned {
	if (dialect === 'none') return { text: raw, ruby: [] };

	let text = raw;
	for (const [pattern, to] of CODES) text = text.replace(pattern, to);
	text = text.replace(BARE_CODES, '');

	const ruby: GameRuby[] = [];

	// Spanning ruby first: its bracket would otherwise be read as a run bracket.
	for (;;) {
		const m = SPANNING.exec(text);
		if (!m) break;
		const span = Number(m[2]) + 1;
		const start = m.index + m[0].length;
		const base = text.slice(start, start + span);
		if (base.length === span) ruby.push({ base, reading: m[1] });
		text = text.slice(0, m.index) + text.slice(start);
	}

	// Then runs of per-character ruby, joined.
	let out = '';
	let i = 0;
	while (i < text.length) {
		if (text[i] === '[' || /[\p{Script=Han}々]/u.test(text[i])) {
			const run = takeRubyRun(text, i);
			if (run) {
				ruby.push({ base: run.base, reading: run.reading });
				out += run.base;
				i = run.end;
				continue;
			}
		}
		out += text[i];
		i += 1;
	}

	return { text: out, ruby };
}
