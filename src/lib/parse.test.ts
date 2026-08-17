import { describe, expect, it } from 'vitest';
import {
	clean,
	containsJapanese,
	emptyState,
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
		const { lines, state } = parseEvent(event('   \n\n  '), { pendingSpeaker: '橘シェリー' });
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
