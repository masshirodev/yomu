/**
 * Spoiler-safe story context.
 *
 * Everything the model is told about the story is filtered to what the reader
 * has already passed. A fact learned at line 900 does not exist when explaining
 * line 400, however useful it would be.
 *
 * This is not only a spoiler feature. A finished route runs to tens of thousands
 * of lines and cannot go in a prompt, so the history has to be compressed no
 * matter what. Bounding that compression by read position is what makes it
 * spoiler-safe, and it costs nothing extra.
 *
 * For a mystery with a trial structure and thirteen suspects, a single leaked
 * fact is worth more than every explanation the feature will ever produce -- so
 * the filter is the part with the tests.
 */

export type CharacterFact = {
	name: string;
	fact: string;
	kind: 'self_reference' | 'speech' | 'relationship' | 'fact';
	/** Line sequence at which this became known. */
	learnedAt: number;
};

export type StoryDigest = {
	/** The digest summarises everything up to and including this line. */
	throughLine: number;
	summary: string;
};

export type ContextLine = {
	seq: number;
	kind: 'dialogue' | 'narration';
	speaker: string | null;
	text: string;
};

export type BuiltContext = {
	digest: string | null;
	facts: CharacterFact[];
	recent: ContextLine[];
};

/**
 * How many preceding lines to quote verbatim. Enough for anaphora -- who
 * "あいつ" is, what "それ" refers to -- without turning every explain into a
 * long-context request.
 */
export const RECENT_LINE_COUNT = 15;

/**
 * Assemble everything the model may know at `currentSeq`.
 *
 * `currentSeq` is inclusive: the line being explained is itself readable, since
 * the reader is looking at it.
 */
export function buildContext(input: {
	currentSeq: number;
	digests: StoryDigest[];
	facts: CharacterFact[];
	lines: ContextLine[];
	recentCount?: number;
}): BuiltContext {
	const { currentSeq, digests, facts, lines } = input;
	const recentCount = input.recentCount ?? RECENT_LINE_COUNT;

	// The newest digest that does not reach past the reader. A digest built
	// through line 900 is unusable at line 400 even though it is "the latest".
	const digest = digests
		.filter((d) => d.throughLine <= currentSeq)
		.sort((a, b) => b.throughLine - a.throughLine)[0];

	return {
		digest: digest?.summary ?? null,
		facts: facts.filter((f) => f.learnedAt <= currentSeq).sort((a, b) => a.learnedAt - b.learnedAt),
		recent: lines
			.filter((l) => l.seq <= currentSeq)
			.sort((a, b) => a.seq - b.seq)
			.slice(-recentCount)
	};
}

/**
 * The instruction block. Stable across every request, so it sits first and is
 * the prompt-cache prefix.
 *
 * The forward-speculation rule is the load-bearing one: the model knows this
 * genre and could reasonably guess where a death-game mystery is going. Guessing
 * correctly in an explanation is indistinguishable from spoiling.
 */
export const SYSTEM_RULES = `You are helping someone read a Japanese visual novel in Japanese. They have watched a great deal of anime, so their listening vocabulary and grammatical intuition are strong, but they have little reading practice. Assume they can follow spoken-register dialogue and struggle with literary narration (地の文).

Explain the line they ask about, using only the story context provided.

Rules that override everything else:
- Use ONLY the provided context. It contains exactly what the reader has already read.
- NEVER speculate about what happens later, who is guilty, what a mystery's answer is, or what a character will turn out to be. If something has not been established in the context, say it has not been established yet.
- Do not draw on outside knowledge of this work even if you recognise it. Your knowledge of how it ends is not something the reader has.
- If a line is foreshadowing, explain the words. Do not point out that it is foreshadowing.

How to explain:
- Lead with the grammar, not the vocabulary. Dictionary lookup is already handled; what the reader needs is why this construction means what it means here.
- Note register and character voice where it carries meaning: 俺/僕/ボク/わたくし, dialect, exaggerated politeness, verbal tics.
- Be concise. This is read mid-sentence, while reading.`;

/** Render the context as the text block the model receives. */
export function renderContext(ctx: BuiltContext): string {
	const parts: string[] = [];

	if (ctx.digest) {
		parts.push(`## The story so far\n${ctx.digest}`);
	}

	if (ctx.facts.length > 0) {
		const byName = new Map<string, string[]>();
		for (const f of ctx.facts) {
			const list = byName.get(f.name);
			if (list) list.push(f.fact);
			else byName.set(f.name, [f.fact]);
		}
		const lines = [...byName].map(([name, facts]) => `- ${name}: ${facts.join('; ')}`);
		parts.push(`## Characters met so far\n${lines.join('\n')}`);
	}

	if (ctx.recent.length > 0) {
		const lines = ctx.recent.map((l) =>
			l.speaker ? `${l.speaker}: ${l.text}` : `[narration] ${l.text}`
		);
		parts.push(`## The last few lines\n${lines.join('\n')}`);
	}

	return parts.join('\n\n');
}
