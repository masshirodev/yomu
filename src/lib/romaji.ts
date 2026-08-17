/**
 * Kana to Hepburn romaji.
 *
 * Deliberately *not* ambient. Romaji is shown only where a reading has already
 * been revealed by a deliberate click, never under the line itself: romaji
 * printed beside every word is read instead of the kana, and the kana never
 * come back. This is the same reasoning that gates the English translation.
 *
 * It exists for the specific gap it fills — katakana recall. Hiragana is solid;
 * loanwords and names written in katakana are where a reading stalls, and
 * those are exactly the tokens whose romaji is worth one click.
 */

const DIGRAPHS: Record<string, string> = {
	きゃ: 'kya',
	きゅ: 'kyu',
	きょ: 'kyo',
	しゃ: 'sha',
	しゅ: 'shu',
	しょ: 'sho',
	ちゃ: 'cha',
	ちゅ: 'chu',
	ちょ: 'cho',
	にゃ: 'nya',
	にゅ: 'nyu',
	にょ: 'nyo',
	ひゃ: 'hya',
	ひゅ: 'hyu',
	ひょ: 'hyo',
	みゃ: 'mya',
	みゅ: 'myu',
	みょ: 'myo',
	りゃ: 'rya',
	りゅ: 'ryu',
	りょ: 'ryo',
	ぎゃ: 'gya',
	ぎゅ: 'gyu',
	ぎょ: 'gyo',
	じゃ: 'ja',
	じゅ: 'ju',
	じょ: 'jo',
	ぢゃ: 'ja',
	ぢゅ: 'ju',
	ぢょ: 'jo',
	びゃ: 'bya',
	びゅ: 'byu',
	びょ: 'byo',
	ぴゃ: 'pya',
	ぴゅ: 'pyu',
	ぴょ: 'pyo',
	// Katakana-only combinations, which is where the loanwords live.
	ふぁ: 'fa',
	ふぃ: 'fi',
	ふぇ: 'fe',
	ふぉ: 'fo',
	うぃ: 'wi',
	うぇ: 'we',
	うぉ: 'wo',
	つぁ: 'tsa',
	つぃ: 'tsi',
	つぇ: 'tse',
	つぉ: 'tso',
	てぃ: 'ti',
	でぃ: 'di',
	とぅ: 'tu',
	どぅ: 'du',
	しぇ: 'she',
	じぇ: 'je',
	ちぇ: 'che',
	ゔぁ: 'va',
	ゔぃ: 'vi',
	ゔぇ: 've',
	ゔぉ: 'vo'
};

const SINGLES: Record<string, string> = {
	あ: 'a',
	い: 'i',
	う: 'u',
	え: 'e',
	お: 'o',
	か: 'ka',
	き: 'ki',
	く: 'ku',
	け: 'ke',
	こ: 'ko',
	さ: 'sa',
	し: 'shi',
	す: 'su',
	せ: 'se',
	そ: 'so',
	た: 'ta',
	ち: 'chi',
	つ: 'tsu',
	て: 'te',
	と: 'to',
	な: 'na',
	に: 'ni',
	ぬ: 'nu',
	ね: 'ne',
	の: 'no',
	は: 'ha',
	ひ: 'hi',
	ふ: 'fu',
	へ: 'he',
	ほ: 'ho',
	ま: 'ma',
	み: 'mi',
	む: 'mu',
	め: 'me',
	も: 'mo',
	や: 'ya',
	ゆ: 'yu',
	よ: 'yo',
	ら: 'ra',
	り: 'ri',
	る: 'ru',
	れ: 're',
	ろ: 'ro',
	わ: 'wa',
	ゐ: 'i',
	ゑ: 'e',
	を: 'o',
	が: 'ga',
	ぎ: 'gi',
	ぐ: 'gu',
	げ: 'ge',
	ご: 'go',
	ざ: 'za',
	じ: 'ji',
	ず: 'zu',
	ぜ: 'ze',
	ぞ: 'zo',
	だ: 'da',
	ぢ: 'ji',
	づ: 'zu',
	で: 'de',
	ど: 'do',
	ば: 'ba',
	び: 'bi',
	ぶ: 'bu',
	べ: 'be',
	ぼ: 'bo',
	ぱ: 'pa',
	ぴ: 'pi',
	ぷ: 'pu',
	ぺ: 'pe',
	ぽ: 'po',
	ゔ: 'vu',
	// Small vowels standing alone, as in ボ、ボク stutters.
	ぁ: 'a',
	ぃ: 'i',
	ぅ: 'u',
	ぇ: 'e',
	ぉ: 'o',
	ゃ: 'ya',
	ゅ: 'yu',
	ょ: 'yo'
};

const VOWELS = new Set(['a', 'i', 'u', 'e', 'o']);

/** Katakana to hiragana, so only one table is needed. ー and 々 pass through. */
function toHiragana(text: string): string {
	let out = '';
	for (const ch of text) {
		const code = ch.codePointAt(0)!;
		out += code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : ch;
	}
	return out;
}

/**
 * Convert a kana reading to Hepburn romaji.
 *
 * Anything that is not kana is passed through unchanged, so a mixed string is
 * degraded rather than mangled.
 */
export function toRomaji(kana: string): string {
	const src = toHiragana(kana);
	let out = '';
	let i = 0;

	while (i < src.length) {
		const pair = src.slice(i, i + 2);

		if (DIGRAPHS[pair]) {
			out += DIGRAPHS[pair];
			i += 2;
			continue;
		}

		const ch = src[i];

		// Sokuon: doubles the next consonant. っ at the very end of a word is a
		// glottal stop with no following sound -- common in this VN's stuttering
		// dialogue (っ……！) -- and is dropped rather than doubling nothing.
		if (ch === 'っ') {
			const nextPair = src.slice(i + 1, i + 3);
			const next = DIGRAPHS[nextPair] ?? SINGLES[src[i + 1]];
			if (next) {
				// Hepburn doubles the ch of chi as tchi, not cchi.
				out += next.startsWith('ch') ? 't' : next[0];
			}
			i += 1;
			continue;
		}

		// ん is always n here, deliberately departing from traditional Hepburn,
		// which writes m before b/m/p (shimbun). This romaji exists to help
		// recall a kana, so it has to map back to one: someone looking at ん and
		// reading "m" learns the wrong sound for the character in front of them.
		// Transliteration for English readers is a different job with different
		// rules, and this is not that.
		//
		// The apostrophe stays, because it serves the same goal from the other
		// side: without it きんえん reads as ki-ne-n and the ん disappears.
		if (ch === 'ん') {
			const nextPair = src.slice(i + 1, i + 3);
			const next = DIGRAPHS[nextPair] ?? SINGLES[src[i + 1]] ?? '';
			out += next && (VOWELS.has(next[0]) || next.startsWith('y')) ? "n'" : 'n';
			i += 1;
			continue;
		}

		// The prolonged sound mark repeats the preceding vowel. Written out rather
		// than as a macron: ō is one more symbol to decode for someone who came
		// here because they could not decode a symbol.
		if (ch === 'ー') {
			const last = out[out.length - 1];
			if (last && VOWELS.has(last)) out += last;
			i += 1;
			continue;
		}

		if (SINGLES[ch]) {
			out += SINGLES[ch];
			i += 1;
			continue;
		}

		out += ch;
		i += 1;
	}

	return out;
}
