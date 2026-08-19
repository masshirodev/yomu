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

describe('the answer, after the answer has been given', () => {
	it('asks for the translation whatever the reader scored', () => {
		// Grading is the committed attempt the translation gate exists to protect.
		// Once it is committed, withholding the answer is marking the exam and
		// refusing to show the paper.
		expect(GRADER_RULES).toMatch(/Always give it, whatever they scored/);
		expect(prompt()).toContain('"translation"');
	});

	it('asks for the structural gloss too', () => {
		// Most useful here of anywhere: they have just tried to parse this sentence
		// themselves and been told which parts they got wrong.
		expect(GRADER_RULES).toMatch(/where their reading and the sentence parted company/);
		expect(prompt()).toContain('"literal"');
	});

	it('keeps the guard against a literal gloss that is literally wrong', () => {
		expect(GRADER_RULES).toMatch(/figurative sense rather than its concrete one/);
		expect(GRADER_RULES).toMatch(/teaches a wrong analysis/);
	});

	it('still refuses to reach past the reader to produce it', () => {
		// The translation is new; the spoiler boundary is not negotiable because of
		// it. A line is translated from what has been read, not from what it will
		// later turn out to mean.
		const p = prompt({
			ctx: buildContext({
				currentSeq: 50,
				digests: [],
				facts: [{ name: '真犯人', fact: 'is the culprit', kind: 'fact', learnedAt: 900 }],
				lines: []
			})
		});
		expect(p).not.toContain('is the culprit');
		expect(p).toMatch(/NEVER refer to anything later/);
	});
});
