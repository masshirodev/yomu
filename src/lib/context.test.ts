import { describe, expect, it } from 'vitest';
import {
	buildContext,
	renderContext,
	SYSTEM_RULES,
	type CharacterFact,
	type ContextLine,
	type StoryDigest
} from './context';

/**
 * These are the tests that matter most in the project.
 *
 * A wrong explanation costs one confusing minute. A leaked fact costs the whole
 * remaining story, and cannot be undone. Every filter here is tested from the
 * spoiler direction: not "does the right thing get through" but "can anything
 * from the future get through".
 */

const fact = (name: string, learnedAt: number, text = `${name}-fact`): CharacterFact => ({
	name,
	fact: text,
	kind: 'fact',
	learnedAt
});

const line = (seq: number, text = `line-${seq}`, speaker: string | null = null): ContextLine => ({
	seq,
	kind: speaker ? 'dialogue' : 'narration',
	speaker,
	text
});

const digest = (throughLine: number, summary = `through-${throughLine}`): StoryDigest => ({
	throughLine,
	summary
});

describe('buildContext — the spoiler boundary', () => {
	it('excludes character facts learned after the current line', () => {
		const ctx = buildContext({
			currentSeq: 500,
			digests: [],
			facts: [fact('エマ', 100), fact('メルル', 499), fact('真犯人', 501), fact('シェリー', 900)],
			lines: []
		});

		expect(ctx.facts.map((f) => f.name)).toEqual(['エマ', 'メルル']);
	});

	it('excludes lines the reader has not reached', () => {
		const ctx = buildContext({
			currentSeq: 10,
			digests: [],
			facts: [],
			lines: [line(9), line(10), line(11), line(50)]
		});

		expect(ctx.recent.map((l) => l.seq)).toEqual([9, 10]);
	});

	it('refuses a digest that summarises past the current line', () => {
		// The critical case: the newest digest is usually the one you want, and is
		// exactly the wrong one to use when the reader is behind it.
		const ctx = buildContext({
			currentSeq: 400,
			digests: [digest(200), digest(900)],
			facts: [],
			lines: []
		});

		expect(ctx.digest).toBe('through-200');
	});

	it('picks the newest digest that is still behind the reader', () => {
		const ctx = buildContext({
			currentSeq: 500,
			digests: [digest(100), digest(300), digest(500), digest(700)],
			facts: [],
			lines: []
		});
		expect(ctx.digest).toBe('through-500');
	});

	it('returns no digest when every digest is ahead of the reader', () => {
		const ctx = buildContext({ currentSeq: 50, digests: [digest(200)], facts: [], lines: [] });
		expect(ctx.digest).toBeNull();
	});

	it('includes the current line itself, which the reader is looking at', () => {
		const ctx = buildContext({ currentSeq: 7, digests: [], facts: [], lines: [line(7)] });
		expect(ctx.recent.map((l) => l.seq)).toEqual([7]);
	});

	it('is not fooled by unordered input', () => {
		// Filtering must not depend on the caller having sorted anything.
		const ctx = buildContext({
			currentSeq: 300,
			digests: [digest(900), digest(100)],
			facts: [fact('future', 800), fact('past', 50)],
			lines: [line(999), line(2), line(301)]
		});

		expect(ctx.digest).toBe('through-100');
		expect(ctx.facts.map((f) => f.name)).toEqual(['past']);
		expect(ctx.recent.map((l) => l.seq)).toEqual([2]);
	});

	it('keeps only the most recent window of lines', () => {
		const lines = Array.from({ length: 100 }, (_, i) => line(i));
		const ctx = buildContext({ currentSeq: 99, digests: [], facts: [], lines, recentCount: 5 });

		expect(ctx.recent.map((l) => l.seq)).toEqual([95, 96, 97, 98, 99]);
	});

	it('handles the very start of the story', () => {
		const ctx = buildContext({ currentSeq: 0, digests: [], facts: [], lines: [line(0)] });
		expect(ctx.digest).toBeNull();
		expect(ctx.facts).toEqual([]);
		expect(ctx.recent).toHaveLength(1);
	});
});

describe('renderContext', () => {
	it('groups several facts under one character', () => {
		const rendered = renderContext(
			buildContext({
				currentSeq: 100,
				digests: [],
				facts: [
					fact('桜羽エマ', 1, 'refers to herself as ボク'),
					fact('桜羽エマ', 2, 'was bullied')
				],
				lines: []
			})
		);

		expect(rendered).toContain('桜羽エマ: refers to herself as ボク; was bullied');
	});

	it('marks narration so the model does not read it as someone speaking', () => {
		const rendered = renderContext(
			buildContext({
				currentSeq: 5,
				digests: [],
				facts: [],
				lines: [line(4, '室内は薄暗く、空気が澱んでいる。'), line(5, 'ろ、牢屋……！？', '桜羽エマ')]
			})
		);

		expect(rendered).toContain('[narration] 室内は薄暗く');
		expect(rendered).toContain('桜羽エマ: ろ、牢屋');
	});

	it('produces nothing at all for an empty context', () => {
		expect(renderContext({ digest: null, facts: [], recent: [] })).toBe('');
	});
});

describe('SYSTEM_RULES', () => {
	it('forbids speculating forward', () => {
		expect(SYSTEM_RULES).toMatch(/NEVER speculate/);
	});

	it('forbids drawing on outside knowledge of the work', () => {
		// The model may well recognise this VN. What it knows about the ending is
		// not something the reader has.
		expect(SYSTEM_RULES).toMatch(/outside knowledge/);
	});
});
