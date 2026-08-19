import { describe, expect, it } from 'vitest';
import {
	clean,
	containsJapanese,
	emptyState,
	mostlyLatin,
	parseEvent,
	type ParseState,
	type RawEvent
} from './parse';

/**
 * Every string in this file is real output from the Phase 0 captures under
 * ~/yomu/capture/ on the home machine. Invented samples would agree with
 * whatever the parser happens to do; these do not.
 */

const event = (text: string): RawEvent => ({ source: 'clipboard', text, ts: 0 });
const linesOf = (text: string, state: ParseState = emptyState()) =>
	parseEvent(event(text), state).lines;

describe('clean', () => {
	it('strips the trailing zero-width space seen in translated output', () => {
		expect(clean('桜羽エマは叫び、起き上がった。​ ')).toBe('桜羽エマは叫び、起き上がった。');
	});

	it('leaves raw hook output untouched', () => {
		const raw = 'エマはパニックに陥りながらも、眠る前の記憶を懸命に手繰り寄せる。';
		expect(clean(raw)).toBe(raw);
	});
});

describe('parseEvent', () => {
	it('emits nothing for a bare speaker name, and remembers it', () => {
		const { lines, state } = parseEvent(event('桜羽エマ\n\n桜羽エマ'));
		expect(lines).toEqual([]);
		expect(state.pendingSpeaker).toBe('桜羽エマ');
	});

	it('attributes a line to a speaker held from an earlier event', () => {
		// The real shape: Copy to Clipboard follows one thread at a time, so the
		// name and its line arrive as two separate clipboard events.
		const first = parseEvent(event('桜羽エマ\n\n桜羽エマ'));
		const second = parseEvent(event('ボ、ボクは、桜羽エマ！'), first.state);

		expect(second.lines).toEqual([
			{ kind: 'dialogue', speaker: '桜羽エマ', text: 'ボ、ボクは、桜羽エマ！' }
		]);
		expect(second.state.pendingSpeaker).toBeNull();
	});

	it('does not reuse a speaker for the line after the one it belongs to', () => {
		const a = parseEvent(event('氷上メルル'));
		const b = parseEvent(event('わわわ、私の名前は、ひっ、ひっ、ひ……'), a.state);
		const c = parseEvent(
			event('つっかえつっかえになりながら、メルルはようやく言い切った。'),
			b.state
		);

		expect(b.lines[0].speaker).toBe('氷上メルル');
		expect(c.lines[0].speaker).toBeNull();
		expect(c.lines[0].kind).toBe('narration');
	});

	it('treats narration as narration', () => {
		expect(linesOf('桜羽エマは叫び、起き上がった。​ ')).toEqual([
			{ kind: 'narration', speaker: null, text: '桜羽エマは叫び、起き上がった。' }
		]);
	});

	it('attributes dialogue when a linked name precedes it in one event', () => {
		expect(linesOf('橘シェリー\n\nそれはまだありませんね！')).toEqual([
			{ kind: 'dialogue', speaker: '橘シェリー', text: 'それはまだありませんね！' }
		]);
	});

	it('does not mistake a short exclamation for a speaker name', () => {
		// Six characters, well under the length cap -- only the punctuation saves it.
		expect(linesOf('――ちがう！')).toEqual([
			{ kind: 'narration', speaker: null, text: '――ちがう！' }
		]);
	});

	it('accepts a katakana name containing a prolonged sound mark', () => {
		expect(linesOf('橘シェリー\n\nそうですよ！ えっへん！')).toEqual([
			{ kind: 'dialogue', speaker: '橘シェリー', text: 'そうですよ！ えっへん！' }
		]);
	});

	it('splits a multi-line backlog flush into separate lines', () => {
		const lines = linesOf('室内は薄暗く、空気が澱んでいる。\nろ、牢屋……！？ なんで！？');
		expect(lines).toHaveLength(2);
		expect(lines.every((l) => l.kind === 'narration')).toBe(true);
	});

	it('ignores an empty event without losing a held speaker', () => {
		const { lines, state } = parseEvent(event('   \n\n  '), {
			...emptyState(),
			pendingSpeaker: '橘シェリー',
			pendingSince: 0
		});
		expect(lines).toEqual([]);
		expect(state.pendingSpeaker).toBe('橘シェリー');
	});
});

describe('containsJapanese — keeping the clipboard out of the line store', () => {
	it('accepts ordinary game text', () => {
		expect(containsJapanese('それはまだありませんね！')).toBe(true);
		expect(containsJapanese('桜羽エマ')).toBe(true);
		expect(containsJapanese('――ここは牢獄だ。')).toBe(true);
	});

	it('rejects the things that actually got captured by accident', () => {
		// All four of these reached the live line store before this filter existed.
		expect(containsJapanese('mtr -rw 193.203.183.1')).toBe(false);
		expect(containsJapanese('bridge/yomu-send.sh')).toBe(false);
		expect(containsJapanese('YOMU_URL=http://100.127.94.72:42139 \\')).toBe(false);
		expect(containsJapanese('YOMU_INGEST_TOKEN=71edb2c25f5750a64f74a0f3312b199b')).toBe(false);
	});

	it('rejects a password-shaped string', () => {
		expect(containsJapanese('hunter2-Correct-Horse-Battery')).toBe(false);
	});
});

describe('parseEvent drops non-Japanese lines', () => {
	it('ignores a copied shell command entirely', () => {
		expect(parseEvent(event('git push origin main')).lines).toEqual([]);
	});

	it('keeps the Japanese half of a mixed event', () => {
		const { lines } = parseEvent(event('some ascii junk\n牢屋に閉じ込められた。'));
		expect(lines).toHaveLength(1);
		expect(lines[0].text).toBe('牢屋に閉じ込められた。');
	});
});

describe('a held speaker must not latch onto narration', () => {
	// Every string here is from the live line store, where the name box fired
	// 二階堂ヒロ, that character's line never arrived, and the name attached
	// itself to the narration that followed.
	const names = ['二階堂ヒロ', '桜羽エマ'];
	const at = (text: string, state: ParseState, ts = 1000) =>
		parseEvent({ source: 'clipboard', text, ts }, state, { names, now: ts });

	it('does not attribute narration about a character to that character', () => {
		const held = at('二階堂ヒロ', emptyState()).state;
		const { lines } = at('ぎりっと強く奥歯を噛みしめる音が響き、ヒロはエマへと振り向く。', held);

		expect(lines[0].speaker).toBeNull();
		expect(lines[0].kind).toBe('narration');
	});

	it('catches the other mis-attributed line too', () => {
		const held = at('二階堂ヒロ', emptyState()).state;
		const { lines } = at('ヒロはエマを存在ごと無視することに決めたのか、歩みを止めない。', held);
		expect(lines[0].speaker).toBeNull();
	});

	it('still attributes real dialogue that mentions another character', () => {
		// ヒロちゃんと is エマ talking about ヒロ, not narration — the と particle
		// is excluded from the third-person test precisely for this line.
		const held = at('桜羽エマ', emptyState()).state;
		const { lines } = at('ボク、変わったんだよ。ヒロちゃんと友だちになりたいんだ。', held);

		expect(lines[0].speaker).toBe('桜羽エマ');
		expect(lines[0].kind).toBe('dialogue');
	});

	it('still attributes a character saying their own name', () => {
		const held = at('桜羽エマ', emptyState()).state;
		expect(at('ボ、ボクは、桜羽エマ！', held).lines[0].speaker).toBe('桜羽エマ');
	});

	it('drops a speaker that has gone stale', () => {
		// The real gap was about five minutes. Dialogue follows its name box
		// within a moment; anything later is a different line entirely.
		const held = at('二階堂ヒロ', emptyState(), 1000).state;
		const { lines } = at('ボク、諦めないから！', held, 1000 + 5 * 60_000);
		expect(lines[0].speaker).toBeNull();
	});

	it('keeps a speaker that arrives promptly', () => {
		const held = at('二階堂ヒロ', emptyState(), 1000).state;
		expect(at('ボク、諦めないから！', held, 1500).lines[0].speaker).toBe('二階堂ヒロ');
	});
});

describe('mostlyLatin — keeping the reader out of its own line store', () => {
	it('rejects the explanation text that got copied back in', () => {
		// Three of these reached the live store: they contain Japanese, so the
		// kana check passes them, but they are plainly not lines from the game.
		expect(
			mostlyLatin('Negative form of 諦める (to give up). The ない form is the plain negative')
		).toBe(true);
	});

	it('accepts real game lines', () => {
		expect(mostlyLatin('ボ、ボク諦めないから！')).toBe(false);
		expect(mostlyLatin('ぎりっと強く奥歯を噛みしめる音が響き、ヒロはエマへと振り向く。')).toBe(
			false
		);
	});

	it('is not upset by empty input', () => {
		expect(mostlyLatin('')).toBe(false);
	});
});

describe('the hook echoing a line it already sent', () => {
	// Measured from the real capture: 「――ここは牢獄だ。」 arrived four times in
	// under a second, and 「あるときは上履きに虫を詰められた。」 twice in 0.35s.
	// Each echo was stored as a line of its own, and the near-zero gap between a
	// line and its own echo went straight into the reading-pace median -- making
	// the measured pace 2.5x faster than the real one.
	const send = (text: string, at: number, state = emptyState()) =>
		parseEvent({ text, source: 'clipboard', ts: at }, state, { now: at });

	it('drops a line the hook repeats a moment later', () => {
		const first = send('――ここは牢獄だ。', 1000);
		const second = send('――ここは牢獄だ。', 1410, first.state);

		expect(first.lines).toHaveLength(1);
		expect(second.lines).toHaveLength(0);
	});

	it('keeps a repetition the story actually wrote', () => {
		// A visual novel really can repeat a line, and the reader has to click
		// through it. Dropping the second one would delete written content, which
		// is a worse failure than keeping a stray copy.
		const first = send('やめて。', 1000);
		const second = send('やめて。', 1000 + 8000, first.state);

		expect(first.lines).toHaveLength(1);
		expect(second.lines).toHaveLength(1);
	});

	it('drops the line the game redraws when you come back', () => {
		// Every resume redraws the line you stopped on. Once per session, forever,
		// so it is not an edge case.
		const before = send('あるときはトイレの個室に閉じ込められた。', 1000);
		const after = send('あるときはトイレの個室に閉じ込められた。', 1000 + 87_861_000, before.state);

		expect(after.lines).toHaveLength(0);
	});

	it('does not suppress a different line arriving quickly', () => {
		const first = send('ま、待ってよヒロちゃん！', 1000);
		const second = send('エマはすぐにヒロの後を追って通路へと出る。', 1000 + 300, first.state);

		expect(second.lines).toHaveLength(1);
	});

	it('checks only the first line of an event', () => {
		// One event can legitimately carry a repeated line -- the prologue arrives
		// as a single 478-character block -- and a within-event repeat is already
		// handled where it is genuinely consecutive.
		const first = send('牢獄だ。', 1000);
		const second = send('牢獄だ。\n鎖だ。\n牢獄だ。', 1200, first.state);

		expect(second.lines.map((l) => l.text)).toEqual(['鎖だ。', '牢獄だ。']);
	});

	it('measures the window from the last line kept, not the last echo seen', () => {
		// Echoes arriving every 1.9s would otherwise walk the window forward
		// indefinitely and each one would be kept.
		let s = emptyState();
		let kept = 0;
		for (let i = 0; i < 5; i++) {
			const r = send('――ここは牢獄だ。', 1000 + i * 400, s);
			kept += r.lines.length;
			s = r.state;
		}
		expect(kept).toBe(1);
	});
});
