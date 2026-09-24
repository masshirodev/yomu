<script lang="ts">
	import type { Token } from 'kotoba';
	import { toRomaji } from 'kotoba';

	type Sense = { pos: string[]; misc: string[]; info: string[]; gloss: string[] };
	type Entry = { id: string; kanji: string[]; kana: string[]; senses: Sense[]; common: boolean };

	type Props = { token: Token; onclose: () => void; onback?: (() => void) | null };
	let { token, onclose, onback = null }: Props = $props();

	const romaji = $derived(toRomaji(token.reading ?? token.surface));

	let entries = $state<Entry[] | null>(null);
	let failed = $state<string | null>(null);

	$effect(() => {
		// Built by hand rather than with URLSearchParams: this is a throwaway local
		// inside an effect, not reactive state, and the reactive wrapper would only
		// obscure that.
		const query = [
			`lemma=${encodeURIComponent(token.lemma)}`,
			`surface=${encodeURIComponent(token.surface)}`,
			...(token.reading ? [`reading=${encodeURIComponent(token.reading)}`] : [])
		].join('&');

		let cancelled = false;
		entries = null;
		failed = null;

		fetch(`/api/define?${query}`)
			.then(async (r) => {
				if (!r.ok) throw new Error(await r.text());
				return r.json();
			})
			.then((d) => {
				if (!cancelled) entries = d.entries;
			})
			.catch((e) => {
				if (!cancelled) failed = String(e);
			});

		return () => {
			cancelled = true;
		};
	});

	// Only the first few senses. JMdict entries for common words run to a dozen
	// or more, and a wall of glosses is harder to read past than it is helpful.
	const SENSE_LIMIT = 4;
</script>

<aside class="max-h-[45vh] overflow-y-auto border-t border-neutral-700 bg-neutral-900 px-6 py-5">
	<div class="flex items-baseline justify-between">
		<p class="font-jp text-xl text-neutral-100">
			{token.surface}
			{#if token.reading && token.reading !== token.surface}
				<span class="ml-2 text-lg text-neutral-300">{token.reading}</span>
			{/if}
			<!-- Romaji is shown whenever romanising adds anything, independent of
			     whether the reading differs from the surface. A bare kana like へ is
			     its own reading, and that is precisely the case where the romaji is
			     the only thing the reader came for. -->
			{#if romaji && romaji !== token.surface}
				<span class="ml-2 font-mono text-sm text-neutral-400">{romaji}</span>
			{/if}
			{#if token.lemma !== token.surface}
				<span class="ml-2 font-mono text-xs text-neutral-600">{token.lemma}</span>
			{/if}
		</p>
		<div class="flex shrink-0 gap-3 font-mono text-xs">
			{#if onback}
				<!-- Returns to whichever panel this word was clicked from -- an
				     explanation or a check. That panel stays mounted behind this one,
				     so nothing is re-fetched, re-generated, or in the case of a
				     check, retyped. -->
				<button class="text-sky-500/80 hover:text-sky-400" onclick={onback}> ← back </button>
			{/if}
			<button class="text-neutral-600 hover:text-neutral-400" onclick={onclose}>close</button>
		</div>
	</div>

	{#if failed}
		<p class="mt-2 font-mono text-xs text-amber-600/80">{failed}</p>
	{:else if entries === null}
		<p class="mt-2 font-mono text-xs text-neutral-600">looking up…</p>
	{:else if entries.length === 0}
		<!-- Character names and proper nouns are not in JMdict, and that is the
		     common case for a clicked speaker label. Saying so beats an empty
		     result that reads like a failure -- the reading and romaji above are
		     the answer being looked for. -->
		<p class="mt-3 font-mono text-xs text-neutral-500">
			{token.reading
				? 'No JMdict entry — character names and proper nouns are not in it. The reading above is from the names list.'
				: `no dictionary entry for ${token.lemma}`}
		</p>
	{:else}
		{#each entries.slice(0, 3) as entry (entry.id)}
			<div class="mt-3 border-t border-neutral-800/60 pt-2 first:border-0">
				<p class="font-jp text-base text-neutral-300">
					{entry.kanji.slice(0, 3).join('、')}
					{#if entry.kanji.length && entry.kana.length}·{/if}
					{entry.kana.slice(0, 2).join('、')}
					{#if entry.common}
						<span class="ml-1 font-mono text-xs text-emerald-500/80">common</span>
					{/if}
				</p>

				<ol class="mt-1 space-y-1">
					{#each entry.senses.slice(0, SENSE_LIMIT) as sense, i (i)}
						<li class="text-base leading-relaxed text-neutral-200">
							<span class="mr-1 font-mono text-xs text-neutral-500">
								{sense.pos.slice(0, 2).join(', ')}
							</span>
							{sense.gloss.join('; ')}
						</li>
					{/each}
					{#if entry.senses.length > SENSE_LIMIT}
						<li class="font-mono text-xs text-neutral-500">
							+{entry.senses.length - SENSE_LIMIT} more senses
						</li>
					{/if}
				</ol>
			</div>
		{/each}
	{/if}
</aside>
