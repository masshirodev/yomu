import { describe, expect, it } from 'vitest';
import { buildPrompt, cacheKey, extractJson, repairInnerQuotes } from './explain';
import { buildContext } from '$lib/context';

const ctx = (opts: Partial<Parameters<typeof buildContext>[0]> = {}) =>
	buildContext({ currentSeq: 100, digests: [], facts: [], lines: [], ...opts });

describe('buildPrompt', () => {
	it('carries the spoiler rules into every prompt', () => {
		const prompt = buildPrompt('それはまだありませんね！', ctx());
		expect(prompt).toMatch(/NEVER speculate/);
		expect(prompt).toMatch(/outside knowledge/);
	});

	it('includes the line being explained', () => {
		expect(buildPrompt('鉄格子に閉ざされていた。', ctx())).toContain('鉄格子に閉ざされていた。');
	});

	it('never includes context from past the reader', () => {
		const prompt = buildPrompt('現在の行', {
			...ctx({
				currentSeq: 50,
				facts: [
					{ name: '真犯人', fact: 'is the culprit', kind: 'fact', learnedAt: 900 },
					{ name: 'エマ', fact: 'uses ボク', kind: 'self_reference', learnedAt: 10 }
				]
			})
		});

		expect(prompt).toContain('エマ');
		expect(prompt).not.toContain('真犯人');
		expect(prompt).not.toContain('is the culprit');
	});

	it('asks for the referent to be resolved only from context', () => {
		expect(buildPrompt('あいつがやった。', ctx())).toMatch(/ONLY the context/);
	});

	it('keeps the translation out of the other fields', () => {
		// Translation is gated behind a deliberate click in the reader; if it leaks
		// into the grammar notes the gate is pointless.
		expect(buildPrompt('x', ctx())).toMatch(/never hedge it into the other fields/);
	});
});

describe('cacheKey', () => {
	it('is stable for the same prompt', () => {
		const p = buildPrompt('同じ行', ctx());
		expect(cacheKey(p)).toBe(cacheKey(p));
	});

	it('differs when the story context differs', () => {
		// The same line early and late in the story is a different question, and
		// must not be served from one cache entry.
		const early = buildPrompt('あいつがやった。', ctx({ currentSeq: 10 }));
		const late = buildPrompt('あいつがやった。', {
			...ctx({
				currentSeq: 500,
				facts: [{ name: 'メルル', fact: 'can heal', kind: 'fact', learnedAt: 200 }]
			})
		});

		expect(cacheKey(early)).not.toBe(cacheKey(late));
	});

	it('differs for different lines', () => {
		expect(cacheKey(buildPrompt('行A', ctx()))).not.toBe(cacheKey(buildPrompt('行B', ctx())));
	});
});

describe('extractJson — OpenCode output shape', () => {
	const answer = { grammar: [], voice: null, reference: null, translation: 'ok' };

	it('reads the answer out of a JSONL event stream', () => {
		// The real shape, captured from `opencode run --pure --format json`: a
		// stream of events, with the reply nested at part.text.
		const stream = [
			JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }),
			JSON.stringify({ type: 'text', part: { type: 'text', text: JSON.stringify(answer) } })
		].join('\n');

		expect(extractJson(stream)).toEqual(answer);
	});

	it('reassembles a reply split across several text events', () => {
		// A single event never reliably holds the whole answer — this is the case
		// that made the first parser fail against the live provider.
		const whole = JSON.stringify(answer);
		const stream = [
			JSON.stringify({ type: 'text', part: { type: 'text', text: whole.slice(0, 20) } }),
			JSON.stringify({ type: 'text', part: { type: 'text', text: whole.slice(20) } })
		].join('\n');

		expect(extractJson(stream)).toEqual(answer);
	});

	it('still accepts a provider that just prints the object', () => {
		expect(extractJson(JSON.stringify(answer))).toEqual(answer);
	});

	it('ignores prose wrapped around the object', () => {
		expect(extractJson(`Here you go:\n${JSON.stringify(answer)}\nHope that helps.`)).toEqual(
			answer
		);
	});

	it('throws rather than returning a half-parsed object', () => {
		expect(() => extractJson('total nonsense, no json here')).toThrow(/no JSON object/);
	});
});

describe('repairInnerQuotes', () => {
	// The real failure: the grader quoted the reader's own words back, and the
	// reader had written double quotes. The attempt was saved but ungraded.
	it('escapes quotes the model wrote inside a value', () => {
		const broken = `{"gist":"partial","note":"You wrote "my instinct" but the line says otherwise"}`;
		expect(JSON.parse(repairInnerQuotes(broken)).note).toBe(
			`You wrote "my instinct" but the line says otherwise`
		);
	});

	it('leaves valid JSON byte-identical', () => {
		// Repair runs only after a clean parse fails, but it must still be a no-op
		// on well-formed input -- a repair that mangles good JSON is worse than no
		// repair at all.
		const ok = `{"gist":"correct","got":["negation","subject"],"note":"Nicely read.","voice":null}`;
		expect(repairInnerQuotes(ok)).toBe(ok);
		expect(JSON.parse(repairInnerQuotes(ok))).toEqual(JSON.parse(ok));
	});

	it('does not double-escape quotes that were already escaped', () => {
		const ok = `{"note":"You wrote \\"maybe\\" here"}`;
		expect(JSON.parse(repairInnerQuotes(ok)).note).toBe(`You wrote "maybe" here`);
	});

	it('survives Japanese and structural characters inside values', () => {
		const broken = `{"gist":"missed","note":"諦めない means "won't give up", not the opposite"}`;
		// The quote before the comma is genuinely ambiguous -- it looks exactly
		// like a terminator. What matters is that it throws with the output
		// attached instead of parsing to something wrong.
		expect(() => JSON.parse(repairInnerQuotes(broken))).toThrow();
	});
});

describe('extractJson salvage', () => {
	it('recovers a verdict whose note contains raw quotes', () => {
		const out = `{"gist":"partial","got":[],"missed":[],"note":"Your phrase "my instinct" is not in the line."}`;
		const v = extractJson(out, 'gist') as { gist: string; note: string };
		expect(v.gist).toBe('partial');
		expect(v.note).toContain('my instinct');
	});

	it('reports what it actually got when nothing is recoverable', () => {
		// "no JSON object found" with no sample is undiagnosable after the fact,
		// which is exactly how the first real failure arrived.
		expect(() => extractJson('provider exploded, sorry', 'gist')).toThrow(/provider exploded/);
	});
});
