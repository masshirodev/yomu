import { describe, expect, it } from 'vitest';
import { formatCard, rankCandidates, type LookupRecord } from './mining';

const look = (
	lemma: string,
	sessionId: number,
	at: number,
	surface = lemma,
	lineId: number | null = 1,
	pos = '名詞'
): LookupRecord => ({ lemma, surface, pos, sessionId, at, lineId });

describe('rankCandidates', () => {
	it('ranks a word met across several sessions above one clicked repeatedly in a moment', () => {
		// Three evenings is a real gap. Three clicks in one minute is usually the
		// panel being reopened or a sentence being reread.
		const spread = [look('蔑む', 1, 100), look('蔑む', 2, 200), look('蔑む', 3, 300)];
		const burst = [look('鉄格子', 1, 100), look('鉄格子', 1, 101), look('鉄格子', 1, 102)];

		const [first] = rankCandidates([...burst, ...spread]);
		expect(first.lemma).toBe('蔑む');
	});

	it('counts lookups and distinct sessions separately', () => {
		const c = rankCandidates([look('嘲笑', 1, 1), look('嘲笑', 1, 2), look('嘲笑', 2, 3)])[0];
		expect(c.lookups).toBe(3);
		expect(c.sessions).toBe(2);
		expect(c.score).toBe(2 * 3 + 3);
	});

	it('keeps the most recent written form and line', () => {
		const c = rankCandidates([
			look('見開く', 1, 100, '見開い', 5),
			look('見開く', 1, 200, '見開か', 9)
		])[0];
		expect(c.surface).toBe('見開か');
		expect(c.lineId).toBe(9);
	});

	it('breaks ties on recency so a review starts with what is fresh', () => {
		const ranked = rankCandidates([look('古い', 1, 100), look('新しい', 1, 900)]);
		expect(ranked.map((c) => c.lemma)).toEqual(['新しい', '古い']);
	});

	it('ignores records with no lemma', () => {
		expect(rankCandidates([look('', 1, 1)])).toEqual([]);
	});

	it('never proposes a particle, however often it is clicked', () => {
		// は ranked fourth on the first real candidate list. Clicking it is useful
		// friction data, but it is grammar, not vocabulary.
		const log = [
			look('は', 1, 1, 'は', 1, '助詞'),
			look('は', 2, 2, 'は', 1, '助詞'),
			look('は', 3, 3, 'は', 1, '助詞')
		];
		expect(rankCandidates(log)).toEqual([]);
	});

	it('drops other function words', () => {
		const log = [
			look('だ', 1, 1, 'だ', 1, '助動詞'),
			look('しかし', 1, 2, 'しかし', 1, '接続詞'),
			look('ああ', 1, 3, 'ああ', 1, '感動詞')
		];
		expect(rankCandidates(log)).toEqual([]);
	});

	it('drops single-kana fragments left by stuttering', () => {
		// ボ、ボクは / ひっ、ひっ、ひ…… tokenise each false start separately.
		expect(rankCandidates([look('ボ', 1, 1), look('ひ', 1, 2)])).toEqual([]);
	});

	it('keeps a single kanji, which is a real word', () => {
		expect(rankCandidates([look('謎', 1, 1)])).toHaveLength(1);
	});

	it('keeps ordinary vocabulary', () => {
		expect(rankCandidates([look('蔑む', 1, 1, '蔑ま', 1, '動詞')])).toHaveLength(1);
	});

	it('returns nothing for an empty log', () => {
		expect(rankCandidates([])).toEqual([]);
	});
});

describe('formatCard', () => {
	it('puts the sentence you actually met the word in on the back', () => {
		const card = formatCard({
			surface: '蔑む',
			reading: 'さげすむ',
			glosses: ['to scorn', 'to despise', 'to hold in contempt'],
			sentence: '蔑まれ、貶められ、嘲笑される毎日に、終わりは見えなかった。',
			speaker: null
		});

		expect(card.front).toBe('蔑む');
		expect(card.back).toContain('さげすむ');
		expect(card.back).toContain('to scorn; to despise; to hold in contempt');
		expect(card.back).toContain('嘲笑される毎日');
	});

	it('keeps the speaker, because register is half of what these characters mean', () => {
		const card = formatCard({
			surface: 'ボク',
			reading: null,
			glosses: ['I', 'me'],
			sentence: 'ボ、ボクは、桜羽エマ！',
			speaker: '桜羽エマ'
		});
		expect(card.back).toContain('桜羽エマ: ボ、ボクは、桜羽エマ！');
	});

	it('omits a reading identical to the surface rather than repeating it', () => {
		const card = formatCard({
			surface: 'ボク',
			reading: 'ボク',
			glosses: ['I'],
			sentence: null,
			speaker: null
		});
		expect(card.back).toBe('I');
	});

	it('survives a candidate with no sentence and no glosses', () => {
		const card = formatCard({
			surface: '謎',
			reading: null,
			glosses: [],
			sentence: null,
			speaker: null
		});
		expect(card.front).toBe('謎');
		expect(card.back).toBe('');
	});
});
