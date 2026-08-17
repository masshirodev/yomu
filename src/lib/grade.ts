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
};

const SCHEMA = {
	type: 'object',
	properties: {
		gist: { type: 'string', enum: ['correct', 'partial', 'missed'] },
		got: { type: 'array', items: { type: 'string' } },
		missed: { type: 'array', items: { type: 'string' } },
		note: { type: 'string' }
	},
	required: ['gist', 'got', 'missed', 'note']
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
