import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '$env/dynamic/private';
import { renderContext, SYSTEM_RULES, type BuiltContext } from '$lib/context';

/**
 * Explanation backend.
 *
 * Provider-agnostic on purpose. The ingest path taught this lesson already: two
 * dead ends (TextractorCLI, Thread Linker) cost nothing because nothing
 * downstream knew where text came from. The model backend got the same
 * treatment after changing three times in one sitting -- Anthropic API, then
 * Claude Code, then OpenCode -- so the provider is a command template in the
 * environment rather than a code path.
 *
 * Defaults to OpenCode because Lattice already drives it successfully on this
 * box and it is markedly cheaper. Measured for comparison: one two-sentence
 * explanation through Claude Code headless cost 13,280 cache-creation tokens,
 * because the agent harness (system prompt, tool schemas, CLAUDE.md) is resent
 * every call. Stripping it with --system-prompt and friends got that to 7,540 --
 * still heavy for a sentence of grammar.
 */

const DEFAULT_BIN = '/home/masshiro/.opencode/bin/opencode';

export function explainBinary(): string {
	return env.YOMU_EXPLAIN_BIN || DEFAULT_BIN;
}

/**
 * Runs the CLI with **stdin closed**.
 *
 * Copied deliberately from Lattice's cli-runner rather than reinvented: it
 * documents that `execFile` always hands the child an open stdin pipe, and that
 * some of these CLIs treat piped stdin as more prompt and block until the
 * timeout. `'ignore'` gives the child /dev/null, which reads EOF immediately.
 */
function runCli(
	file: string,
	args: readonly string[],
	options: { cwd: string; timeoutMs: number; maxOutputBytes?: number }
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(file, [...args], {
			cwd: options.cwd,
			stdio: ['ignore', 'pipe', 'pipe']
		});

		const limit = options.maxOutputBytes ?? 1024 * 1024;
		let stdout = '';
		let stderr = '';
		let settled = false;

		const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);

		const settle = (action: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			action();
		};

		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (c: string) => {
			if (stdout.length < limit) stdout += c;
		});
		child.stderr.on('data', (c: string) => {
			if (stderr.length < limit) stderr += c;
		});

		child.on('error', (err) => settle(() => reject(err)));
		child.on('close', (code, signal) => {
			settle(() => {
				if (code === 0) return resolve({ stdout, stderr });
				reject(
					new Error(
						signal === 'SIGKILL'
							? `explain timed out after ${options.timeoutMs}ms`
							: `explain exited with code ${code}: ${stderr.slice(0, 400)}`
					)
				);
			});
		});
	});
}

export type Explanation = {
	grammar: { point: string; explanation: string }[];
	voice: string | null;
	reference: string | null;
	translation: string;
};

const SCHEMA = {
	type: 'object',
	properties: {
		grammar: {
			type: 'array',
			items: {
				type: 'object',
				properties: { point: { type: 'string' }, explanation: { type: 'string' } },
				required: ['point', 'explanation']
			}
		},
		voice: { type: ['string', 'null'] },
		reference: { type: ['string', 'null'] },
		translation: { type: 'string' }
	},
	required: ['grammar', 'voice', 'reference', 'translation']
};

/**
 * The prompt is assembled here rather than in the route so it can be hashed for
 * the cache and tested without a subprocess.
 */
export function buildPrompt(line: string, ctx: BuiltContext, span?: string | null): string {
	const context = renderContext(ctx);

	return [
		SYSTEM_RULES,
		context ? `\n# Story context (everything the reader has read)\n\n${context}` : '',
		`\n# The line to explain\n\n${line}`,
		// A selected phrase is explained in the context of its whole line, not in
		// isolation. Meaning in Japanese lives in phrases -- ぎりっと alone has
		// almost no dictionary presence, while ぎりっと強く奥歯を噛みしめる is
		// perfectly clear -- so the span narrows the focus without losing the
		// sentence it sits in.
		span ? `\n# Focus on this phrase within that line\n\n${span}` : '',
		`\nFields: "grammar" is the constructions worth explaining here, most important first.`,
		`"voice" is register or character-voice worth noting, or null.`,
		`"reference" resolves any pronoun or referent using ONLY the context above, or null if it has not been established.`,
		`"translation" is a plain English rendering — it is shown only if the reader deliberately asks, so never hedge it into the other fields.`,
		`\nReturn only a JSON object matching this schema exactly:\n${JSON.stringify(SCHEMA)}`
	].join('\n');
}

/**
 * Cache key covers the prompt in full, so the same line met in a different place
 * in the story is a different question and gets asked again, while a reread of
 * the same passage is free.
 */
export function cacheKey(prompt: string): string {
	return createHash('sha256').update(prompt).digest('hex').slice(0, 32);
}

/**
 * Pull the answer out of OpenCode's output.
 *
 * `--format json` is JSONL, not a JSON document: a stream of event objects, and
 * the model's actual reply arrives as `part.text` on the `text` events -- often
 * split across several of them, so a single event never holds the whole answer.
 * Walking for text and concatenating is what Lattice does, for the same reason.
 *
 * Also tolerates a provider that simply prints the object, so swapping the
 * command for a different CLI does not require touching this.
 */
export function extractText(value: unknown, out: string[]): void {
	if (!value || typeof value !== 'object') return;
	if (Array.isArray(value)) {
		for (const item of value) extractText(item, out);
		return;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.text === 'string') out.push(record.text);
	for (const key of ['part', 'message', 'content', 'data']) extractText(record[key], out);
}

/**
 * Escapes double quotes that sit *inside* a JSON string value.
 *
 * The grader is asked not to emit them, but instructions are not a guarantee
 * and the reader's own words are what get quoted back, so this is the net.
 *
 * A quote ends a string only when the next meaningful character is structural
 * (`,` `}` `]` `:`). Anything else means the model wrote a quote mid-sentence.
 * This cannot fix every case -- `he said "yes", ok` looks exactly like a
 * terminator followed by a comma -- but those fall through to the error below
 * with the raw output attached, rather than being silently mis-parsed.
 */
export function repairInnerQuotes(json: string): string {
	let out = '';
	let inString = false;

	for (let i = 0; i < json.length; i++) {
		const c = json[i];

		if (!inString) {
			out += c;
			if (c === '"') inString = true;
			continue;
		}

		if (c === '\\') {
			out += c + (json[i + 1] ?? '');
			i++;
			continue;
		}

		if (c !== '"') {
			out += c;
			continue;
		}

		let j = i + 1;
		while (j < json.length && /\s/u.test(json[j])) j++;
		const next = json[j];

		if (next === undefined || next === ',' || next === '}' || next === ']' || next === ':') {
			out += c;
			inString = false;
		} else {
			out += '\\"';
		}
	}

	return out;
}

export function extractJson(output: string, requiredKey = 'translation'): unknown {
	const fragments: string[] = [];
	for (const line of output.split('\n')) {
		if (!line.trim()) continue;
		try {
			extractText(JSON.parse(line), fragments);
		} catch {
			// Not an event line; keep it as a candidate for the plain-output case.
		}
	}

	// Markdown fences are common and harmless; strip them before looking for
	// braces so the span search is not thrown off by surrounding prose.
	const strip = (t: string) => t.replace(/```(?:json)?/gu, '');
	const candidates = [strip(fragments.join('')), strip(output)];
	for (const candidate of candidates) {
		const first = candidate.indexOf('{');
		const last = candidate.lastIndexOf('}');
		if (first === -1 || last <= first) continue;
		try {
			const parsed = JSON.parse(candidate.slice(first, last + 1));
			if (parsed && typeof parsed === 'object' && requiredKey in parsed) return parsed;
		} catch {
			continue;
		}
	}
	// Salvage: a model that quotes the reader back with raw double quotes emits
	// JSON that is structurally right but unparseable. Repairing it recovers the
	// grading rather than losing the reader's writing to a punctuation slip.
	for (const candidate of candidates) {
		const first = candidate.indexOf('{');
		const last = candidate.lastIndexOf('}');
		if (first === -1 || last <= first) continue;
		try {
			const parsed = JSON.parse(repairInnerQuotes(candidate.slice(first, last + 1)));
			if (parsed && typeof parsed === 'object' && requiredKey in parsed) return parsed;
		} catch {
			continue;
		}
	}

	// Include a slice of what actually came back. "no JSON object found" with no
	// sample is undiagnosable after the fact, which is how the first failure was.
	throw new Error(
		`no JSON object found in provider output (got: ${output.slice(-300).replace(/\s+/gu, ' ')})`
	);
}

export function explainConfigured(): boolean {
	return Boolean(env.YOMU_EXPLAIN_BIN || DEFAULT_BIN);
}

/**
 * Run a prompt through the configured provider and parse its answer.
 *
 * `requiredKey` is what distinguishes a complete answer from a fragment: the
 * provider streams text in pieces, so the parser needs to know which key marks
 * the object it is looking for. Explanations carry `translation`, grades carry
 * `gist`.
 */
export async function runProvider<T>(prompt: string, requiredKey: string): Promise<T> {
	const model = env.YOMU_EXPLAIN_MODEL;
	const variant = env.YOMU_EXPLAIN_VARIANT || 'minimal';

	const args = ['run', '--pure', '--format', 'json', '--variant', variant];
	if (model) args.push('--model', model);
	args.push(prompt);

	// A scratch cwd so the CLI cannot pick up this repository's own context.
	const dir = mkdtempSync(join(tmpdir(), 'yomu-explain-'));
	try {
		const { stdout } = await runCli(explainBinary(), args, {
			cwd: dir,
			timeoutMs: Number(env.YOMU_EXPLAIN_TIMEOUT_MS ?? 120_000)
		});
		return extractJson(stdout, requiredKey) as T;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export function runExplain(prompt: string): Promise<Explanation> {
	return runProvider<Explanation>(prompt, 'translation');
}
