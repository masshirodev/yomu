<script lang="ts">
	import { toRomaji } from '$lib/romaji';

	type Candidate = {
		lemma: string;
		surface: string;
		lookups: number;
		sessions: number;
		score: number;
		sentence: string | null;
		speaker: string | null;
		reading: string | null;
		glosses: string[];
	};

	type Props = { onclose: () => void };
	let { onclose }: Props = $props();

	let candidates = $state<Candidate[] | null>(null);
	let counts = $state({ approved: 0, rejected: 0 });
	let latticeReady = $state(true);
	let busy = $state<string | null>(null);
	let failed = $state<string | null>(null);

	async function load() {
		const d = await (await fetch('/api/mining')).json();
		candidates = d.candidates;
		counts = d.counts;
		latticeReady = d.latticeReady;
	}

	async function decide(lemma: string, action: 'approve' | 'reject') {
		busy = lemma;
		failed = null;
		try {
			const res = await fetch('/api/mining', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ lemma, action })
			});
			if (!res.ok) throw new Error(await res.text());
			// Drop it locally rather than refetching, so approving a run of words does
			// not reshuffle the list under the cursor between clicks.
			candidates = (candidates ?? []).filter((c) => c.lemma !== lemma);
			counts = (await res.json()).counts;
		} catch (e) {
			failed = String(e);
		} finally {
			busy = null;
		}
	}

	$effect(() => {
		load().catch((e) => (failed = String(e)));
	});
</script>

<aside class="max-h-[60vh] overflow-y-auto border-t border-neutral-800 bg-neutral-900/80 px-6 py-4">
	<div class="flex items-baseline justify-between">
		<p class="font-mono text-xs tracking-wider text-neutral-400 uppercase">mining candidates</p>
		<button class="font-mono text-xs text-neutral-600 hover:text-neutral-400" onclick={onclose}>
			close
		</button>
	</div>

	<p class="mt-1 font-mono text-[10px] text-neutral-600">
		Ranked by what actually cost you time, not by frequency. A word met across several sessions
		outranks one clicked repeatedly in a single moment. {counts.approved} mined · {counts.rejected} skipped.
	</p>

	{#if !latticeReady}
		<p class="mt-2 font-mono text-xs text-amber-600/80">
			LATTICE_TOKEN is not configured — approving will fail.
		</p>
	{/if}

	{#if failed}
		<p class="mt-2 font-mono text-xs text-amber-600/80">{failed}</p>
	{/if}

	{#if candidates === null}
		<p class="mt-3 font-mono text-xs text-neutral-600">loading…</p>
	{:else if candidates.length === 0}
		<p class="mt-3 font-mono text-xs text-neutral-600">
			Nothing pending. Candidates appear as you look words up.
		</p>
	{:else}
		<ul class="mt-3 space-y-3">
			{#each candidates as c (c.lemma)}
				<li class="rounded border border-neutral-800/80 px-3 py-2">
					<div class="flex items-baseline justify-between gap-3">
						<p class="font-jp text-lg text-neutral-100">
							{c.surface}
							{#if c.reading && c.reading !== c.surface}
								<span class="ml-2 text-sm text-neutral-500">{c.reading}</span>
								<span class="ml-2 font-mono text-[10px] text-neutral-600"
									>{toRomaji(c.reading)}</span
								>
							{/if}
						</p>
						<span class="shrink-0 font-mono text-[10px] text-neutral-600">
							{c.sessions} session{c.sessions === 1 ? '' : 's'} · {c.lookups}×
						</span>
					</div>

					{#if c.glosses.length}
						<p class="mt-0.5 text-sm text-neutral-400">{c.glosses.slice(0, 3).join('; ')}</p>
					{/if}

					{#if c.sentence}
						<p class="font-jp mt-1 text-sm leading-relaxed text-neutral-500">
							{#if c.speaker}<span class="text-sky-500/70">{c.speaker}: </span>{/if}{c.sentence}
						</p>
					{/if}

					<div class="mt-2 flex gap-2 font-mono text-xs">
						<button
							class="rounded border border-emerald-800/60 px-2 py-0.5 text-emerald-500/90
								hover:bg-emerald-900/30 disabled:opacity-40"
							disabled={busy === c.lemma}
							onclick={() => decide(c.lemma, 'approve')}
						>
							{busy === c.lemma ? 'sending…' : 'mine'}
						</button>
						<button
							class="rounded border border-neutral-800 px-2 py-0.5 text-neutral-500
								hover:bg-neutral-800/50 disabled:opacity-40"
							disabled={busy === c.lemma}
							onclick={() => decide(c.lemma, 'reject')}
						>
							skip
						</button>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</aside>
