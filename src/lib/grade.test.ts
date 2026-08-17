import { describe, expect, it } from 'vitest';
import { buildGradePrompt, GRADER_RULES } from './grade';
import { buildContext } from './context';

const ctx = (opts: Partial<Parameters<typeof buildContext>[0]> = {}) =>
	buildContext({ currentSeq: 100, digests: [], facts: [], lines: [], ...opts });

const prompt = (over: Partial<Parameters<typeof buildGradePrompt>[0]> = {}) =>
	buildGradePrompt({
		line: 'ボ、ボク諦めないから！',
		guess: "I won't give up",
		speaker: '桜羽エマ',
		ctx: ctx(),
		...over
	});

describe('buildGradePrompt', () => {
	it('includes the line, the speaker and the guess', () => {
		const p = prompt();
		expect(p).toContain('ボ、ボク諦めないから！');
		expect(p).toContain('桜羽エマ');
		expect(p).toContain("I won't give up");
	});

	it('carries the spoiler rules', () => {
		expect(prompt()).toMatch(/NEVER refer to anything later/);
		expect(prompt()).toMatch(/outside knowledge/);
	});

	it('never leaks context from past the reader', () => {
		// The grader gets the same read-position boundary as the explainer. A
		// grader that explains a line by what it foreshadows would spoil the story
		// from inside a study feature.
		const p = prompt({
			ctx: ctx({
				currentSeq: 50,
				facts: [
					{ name: '真犯人', fact: 'is the culprit', kind: 'fact', learnedAt: 900 },
					{ name: 'エマ', fact: 'uses ボク', kind: 'self_reference', learnedAt: 10 }
				]
			})
		});

		expect(p).toContain('エマ');
		expect(p).not.toContain('is the culprit');
	});

	it('works for a line with no speaker', () => {
		const p = prompt({ speaker: null, line: '牢屋に閉じ込められていた。' });
		expect(p).toContain('牢屋に閉じ込められていた。');
		expect(p).not.toContain('null');
	});
});

describe('GRADER_RULES', () => {
	it('is generous about English wording', () => {
		// The reader is writing a rough gloss mid-sentence. Marking them down for
		// clumsy English would punish the exact behaviour worth encouraging.
		expect(GRADER_RULES).toMatch(/generous about wording/);
	});

	it('is strict about meaning that actually changes the sentence', () => {
		expect(GRADER_RULES).toMatch(/negation/);
		expect(GRADER_RULES).toMatch(/strict about meaning/);
	});

	it('refuses to invent partial credit', () => {
		expect(GRADER_RULES).toMatch(/rather than inventing partial credit/);
	});

	it('asks for a concrete note rather than generic praise', () => {
		expect(GRADER_RULES).toMatch(/Never generic praise/);
	});
});
