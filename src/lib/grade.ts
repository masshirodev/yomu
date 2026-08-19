import { renderContext, type BuiltContext } from './context';

/**
 * Grading a written attempt at a line's meaning.
 *
 * This is the only place yomu measures *production* rather than recognition.
 * Everything else records what was clicked or how long a line was looked at,
 * and a click only ever proves ignorance -- not clicking proves nothing at all.
 * A written guess, committed before any answer is shown, separates the three
 * cases a click cannot: read it correctly, read it wrongly but confidently, and
 * did not read it.
 *
 * The prompt is built here rather than in the route so it can be tested without
 * a subprocess, the same as the explanation prompt.
 */

export type Verdict = {
	/** How the overall meaning landed. */
	gist: 'correct' | 'partial' | 'missed';
	/** Things the reader genuinely got, named specifically. */
	got: string[];
	/** Things missed or misread, each with what it actually means. */
	missed: string[];
	/** One sentence, addressed to the reader. */
	note: string;
	/**
	 * The line read structurally, in Japanese order.
	 *
	 * More useful here than anywhere else it appears: you have just tried to
	 * parse this sentence yourself and been told which parts you got wrong, so
	 * the gloss shows exactly where your reading and the sentence diverged.
	 */
	literal: string;
	/**
	 * What the line actually says.
	 *
	 * Not gated, unlike the translation in the explain panel. That gate exists so
	 * the line is attempted before English is seen, and grading *is* that attempt,
	 * already committed and unchangeable. Withholding the answer after the answer
	 * has been given is not protecting anything -- it is marking the exam and
	 * refusing to show the paper.
	 */
	translation: string;
};

const SCHEMA = {
	type: 'object',
	properties: {
		gist: { type: 'string', enum: ['correct', 'partial', 'missed'] },
		got: { type: 'array', items: { type: 'string' } },
		missed: { type: 'array', items: { type: 'string' } },
		note: { type: 'string' },
		literal: { type: 'string' },
		translation: { type: 'string' }
	},
	required: ['gist', 'got', 'missed', 'note', 'literal', 'translation']
};

/**
 * The grading instructions.
 *
 * Deliberately generous about form and strict about meaning. The reader is
 * writing a rough gloss mid-sentence, not a translation for publication, so
 * marking them down for clumsy English would punish exactly the behaviour worth
 * encouraging. What matters is whether the Japanese was understood.
 */
export const GRADER_RULES = `You are checking a Japanese learner's understanding of one line from a visual novel.

They wrote what they thought the line meant, before seeing any answer. Judge only whether they understood the Japanese.

Rules:
- Be generous about wording, register and English style. A rough, clumsy or partial gloss that shows the meaning was understood is correct. They are writing quickly while reading, not translating for publication.
- Be strict about meaning. Who did what to whom, negation, tense, and who is speaking all matter. Getting the polarity or the subject wrong is not a small slip.
- "got" names what they genuinely understood, specifically — the verb, the negation, who the subject is. Empty if nothing.
- "missed" names what they missed or misread, and says what it actually means. Empty if nothing.
- "note" is one sentence addressed to them directly. Encouraging when they did well, concrete when they did not. Never generic praise.
- If they wrote something with no relation to the line, or clearly did not know, say so plainly rather than inventing partial credit.
- "translation" is what the line actually says, in natural English. Always give it, whatever they scored — it is the answer to the question they just attempted.
- "literal" is the same line read structurally, following Japanese order and keeping each word's own sense, so they can see where their reading and the sentence parted company. Where a word is figurative, use its figurative sense rather than its concrete one — 色 in 嫌悪の色 is a tinge, not a colour — because a gloss that is literal but wrong teaches a wrong analysis.
- When referring to what they wrote, paraphrase it or wrap it in single quotes. Never use double quotes inside any field: the reply is parsed as JSON and a raw double quote inside a string breaks it.

Spoiler rules, which override the above:
- Use ONLY the provided story context. It is exactly what the reader has already read.
- NEVER refer to anything later in the story, even to explain the line. If a word's significance is not yet established, do not establish it.
- Do not draw on outside knowledge of this work.`;

export function buildGradePrompt(input: {
	line: string;
	guess: string;
	speaker: string | null;
	ctx: BuiltContext;
}): string {
	const context = renderContext(input.ctx);

	return [
		GRADER_RULES,
		context ? `\n# Story context (everything the reader has read)\n\n${context}` : '',
		`\n# The line\n\n${input.speaker ? `${input.speaker}: ` : ''}${input.line}`,
		`\n# What the reader thought it meant\n\n${input.guess}`,
		`\nReturn only a JSON object matching this schema exactly:\n${JSON.stringify(SCHEMA)}`
	].join('\n');
}
