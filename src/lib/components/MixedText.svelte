<script lang="ts">
	import { tokenize, type Token } from '$lib/tokenize';
	import { splitRuns, isReadable, type Run } from '$lib/mixed';

	/**
	 * English prose with Japanese embedded in it, rendered so the Japanese is
	 * actually readable: furigana on, and every word clickable.
	 *
	 * Furigana is unconditional here, unlike the story text. This is already an
	 * assistance surface that was opened deliberately, and the reader is looking
	 * at it because they could not read something — withholding readings inside
	 * the explanation reproduces the exact problem it exists to solve.
	 */
	type Props = { text: string; onlookup: (token: Token) => void };
	let { text, onlookup }: Props = $props();

	type Rendered = { run: Run; tokens: Token[] | null };

	let parts = $state<Rendered[]>([]);

	$effect(() => {
		const runs = splitRuns(text);
		let cancelled = false;

		// Show the text immediately, unanalysed, then upgrade the Japanese runs as
		// the tokenizer answers. An explanation that appears late is worse than one
		// that appears plain and gains furigana a moment later.
		parts = runs.map((run) => ({ run, tokens: null }));

		Promise.all(
			runs.map(async (run) => (isReadable(run) ? await tokenize(run.text).catch(() => null) : null))
		).then((results) => {
			if (!cancelled) parts = runs.map((run, i) => ({ run, tokens: results[i] }));
		});

		return () => {
			cancelled = true;
		};
	});
</script>

{#each parts as part, i (i)}{#if part.tokens}{#each part.tokens as token, j (j)}{#if token.lookupable}<span
					role="button"
					tabindex="-1"
					class="font-jp cursor-pointer rounded-sm hover:bg-sky-500/20"
					onclick={() => onlookup(token)}
					onkeydown={(e) => e.key === 'Enter' && onlookup(token)}
					>{#each token.segments as seg, k (k)}{#if seg.ruby}<ruby
								>{seg.text}<rt class="text-[0.6em] text-neutral-400">{seg.ruby}</rt></ruby
							>{:else}{seg.text}{/if}{/each}</span
				>{:else}<span class="font-jp">{token.surface}</span>{/if}{/each}{:else}{part.run
			.text}{/if}{/each}
