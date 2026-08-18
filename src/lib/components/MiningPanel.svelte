<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { toRomaji } from '$lib/romaji';
	import { tokenize } from '$lib/tokenize';
	import CardPreview from './CardPreview.svelte';

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

	type Draft = { lemma: string; front: string; back: string; tags: string };

	type Mined = {
		lemma: string;
		noteId: string;
		surface: string;
		sentence: string | null;
		speaker: string | null;
	};

	type Props = { onclose: () => void };
	let { onclose }: Props = $props();

	let candidates = $state<Candidate[] | null>(null);
	let drafts = $state<Draft[]>([]);
	const selected = new SvelteSet<string>();
	let counts = $state({ approved: 0, rejected: 0 });
	let latticeReady = $state(true);
	let busy = $state<string | null>(null);
	let failed = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let mined = $state<Mined[]>([]);

	const MAX_BATCH = 12;
	const pending = $derived(
		candidates?.filter((c) => !drafts.some((d) => d.lemma === c.lemma)) ?? []
	);

	async function load() {
		const d = await (await fetch('/api/mining')).json();
		candidates = d.candidates;
		drafts = d.drafts ?? [];
		counts = d.counts;
		latticeReady = d.latticeReady;

		const r = await (await fetch('/api/mining/rebuild')).json();
		mined = r.words ?? [];
	}

	/** Tokenise a sentence for the server, which has no tokenizer of its own. */
	async function tokensFor(sentence: string | null) {
		if (!sentence) return [];
		return (await tokenize(sentence)).map((t) => ({ surface: t.surface, reading: t.reading }));
	}

	/**
	 * Rebuild cards that were sent before the format could carry readings.
	 *
	 * Done in batches for the same reason enrichment is: one provider call for
	 * the group. Rewriting a note leaves its schedule alone, so a card halfway
	 * through learning keeps every review it has earned.
	 */
	async function rebuild() {
		if (!mined.length || busy) return;
		busy = 'rebuild';
		failed = null;
		notice = null;

		try {
			const todo = mined.slice(0, MAX_BATCH);
			const items = await Promise.all(
				todo.map(async (m) => ({ lemma: m.lemma, tokens: await tokensFor(m.sentence) }))
			);

			const res = await fetch('/api/mining/rebuild', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ items })
			});
			if (!res.ok) throw new Error(await res.text());

			const d = await res.json();
			const done = new Set<string>(d.rebuilt);
			mined = mined.filter((m) => !done.has(m.lemma));
			if (d.error) notice = `Rebuilt from the dictionary only — ${d.error}`;
			if (d.failed?.length) {
				failed = d.failed
					.map((f: { lemma: string; error: string }) => `${f.lemma}: ${f.error}`)
					.join(' · ');
			}
		} catch (e) {
			failed = String(e);
		} finally {
			busy = null;
		}
	}

	function toggle(lemma: string) {
		if (selected.has(lemma)) selected.delete(lemma);
		else if (selected.size < MAX_BATCH) selected.add(lemma);
	}

	/**
	 * Enrich the selection.
	 *
	 * The sentences are tokenised here because the tokenizer is browser-only by
	 * design -- the host running this has four cores and two dozen containers, and
	 * putting morphological analysis on it was never the plan. Sending the
	 * readings along is what lets the server write furigana without one.
	 */
	async function enrich() {
		if (!selected.size || busy) return;
		busy = 'enrich';
		failed = null;
		notice = null;

		try {
			const chosen = (candidates ?? []).filter((c) => selected.has(c.lemma));
			const items = await Promise.all(
				chosen.map(async (c) => ({ lemma: c.lemma, tokens: await tokensFor(c.sentence) }))
			);

			const res = await fetch('/api/mining/enrich', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ items })
			});
			if (!res.ok) throw new Error(await res.text());

			const d = await res.json();
			drafts = [
				...drafts.filter((x) => !d.drafts.some((n: Draft) => n.lemma === x.lemma)),
				...d.drafts
			];
			selected.clear();
			// A provider failure still yields dictionary-only cards, so this is a
			// note about quality rather than an error about nothing happening.
			if (d.error) notice = `Cards built from the dictionary only — ${d.error}`;
		} catch (e) {
			failed = String(e);
		} finally {
			busy = null;
		}
	}

	async function createAll() {
		if (!drafts.length || busy) return;
		busy = 'create';
		failed = null;
		notice = null;

		try {
			const res = await fetch('/api/mining', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action: 'create', lemmas: drafts.map((d) => d.lemma) })
			});
			if (!res.ok) throw new Error(await res.text());

			const d = await res.json();
			counts = d.counts;
			// Only what Lattice confirmed leaves the list. A card that failed to send
			// stays exactly where it is, still enriched, ready to retry.
			const created = new Set<string>(d.created);
			drafts = drafts.filter((x) => !created.has(x.lemma));
			candidates = (candidates ?? []).filter((c) => !created.has(c.lemma));
			if (d.failed?.length) {
				failed = d.failed
					.map((f: { lemma: string; error: string }) => `${f.lemma}: ${f.error}`)
					.join(' · ');
			}
		} catch (e) {
			failed = String(e);
		} finally {
			busy = null;
		}
	}

	async function discard(lemma: string) {
		busy = lemma;
		try {
			await fetch('/api/mining/enrich', {
				method: 'DELETE',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ lemma })
			});
			drafts = drafts.filter((d) => d.lemma !== lemma);
		} finally {
			busy = null;
		}
	}

	async function skip(lemma: string) {
		busy = lemma;
		failed = null;
		try {
			const res = await fetch('/api/mining', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ lemma, action: 'reject' })
			});
			if (!res.ok) throw new Error(await res.text());
			candidates = (candidates ?? []).filter((c) => c.lemma !== lemma);
			drafts = drafts.filter((d) => d.lemma !== lemma);
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
		Ranked by what actually cost you time, not by frequency. Select what is worth keeping, enrich
		the batch, then send it. {counts.approved} mined · {counts.rejected} skipped.
	</p>

	{#if !latticeReady}
		<p class="mt-2 font-mono text-xs text-amber-600/80">
			LATTICE_TOKEN is not configured — sending will fail.
		</p>
	{/if}

	{#if failed}
		<p class="mt-2 font-mono text-xs text-rose-500/80">{failed}</p>
	{/if}
	{#if notice}
		<p class="mt-2 font-mono text-xs text-amber-600/80">{notice}</p>
	{/if}

	{#if mined.length}
		<section class="mt-4 rounded border border-neutral-800/80 px-3 py-2">
			<div class="flex items-baseline justify-between gap-3">
				<p class="font-mono text-[10px] text-neutral-500">
					{mined.length} card{mined.length === 1 ? '' : 's'} in Lattice predate readings.
				</p>
				<button
					class="shrink-0 rounded border border-neutral-700 px-2 py-0.5 font-mono text-xs
						text-neutral-400 hover:bg-neutral-800/50 disabled:opacity-40"
					disabled={busy !== null}
					onclick={rebuild}
				>
					{busy === 'rebuild' ? 'rebuilding…' : `rebuild ${Math.min(mined.length, MAX_BATCH)}`}
				</button>
			</div>
			<p class="mt-1 font-mono text-[10px] text-neutral-700">
				Rewrites the card text in place. Review schedules are untouched. The section goes away once
				every card is current.
			</p>
		</section>
	{/if}

	{#if drafts.length}
		<section class="mt-4 rounded border border-emerald-900/50 bg-emerald-950/10 px-3 py-3">
			<div class="flex items-baseline justify-between gap-3">
				<p class="font-mono text-xs tracking-wider text-emerald-500/80 uppercase">
					ready to send · {drafts.length}
				</p>
				<button
					class="rounded border border-emerald-800/60 px-2 py-0.5 font-mono text-xs text-emerald-400
						hover:bg-emerald-900/30 disabled:opacity-40"
					disabled={busy !== null}
					onclick={createAll}
				>
					{busy === 'create' ? 'sending…' : `send ${drafts.length} to lattice`}
				</button>
			</div>

			<ul class="mt-3 space-y-3">
				{#each drafts as d (d.lemma)}
					<li class="rounded border border-neutral-800/80 bg-neutral-950/40 px-3 py-2">
						<div class="flex items-baseline justify-between gap-3">
							<p class="font-jp text-lg text-neutral-100">{d.front}</p>
							<button
								class="shrink-0 font-mono text-[10px] text-neutral-600 hover:text-neutral-400"
								disabled={busy !== null}
								onclick={() => discard(d.lemma)}
							>
								discard
							</button>
						</div>
						<CardPreview text={d.back} />
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if candidates === null}
		<p class="mt-3 font-mono text-xs text-neutral-600">loading…</p>
	{:else if pending.length === 0}
		<p class="mt-3 font-mono text-xs text-neutral-600">
			Nothing pending. Candidates appear as you look words up.
		</p>
	{:else}
		<div class="mt-4 flex items-center gap-3">
			<button
				class="rounded border border-sky-800/60 px-2 py-0.5 font-mono text-xs text-sky-400
					hover:bg-sky-900/30 disabled:opacity-40"
				disabled={selected.size === 0 || busy !== null}
				onclick={enrich}
			>
				{busy === 'enrich' ? 'enriching…' : `enrich ${selected.size || ''} selected`}
			</button>
			<span class="font-mono text-[10px] text-neutral-600">
				one request for the batch · up to {MAX_BATCH}
			</span>
		</div>

		<ul class="mt-3 space-y-3">
			{#each pending as c (c.lemma)}
				{@const on = selected.has(c.lemma)}
				<li
					class="rounded border px-3 py-2 {on
						? 'border-sky-800/70 bg-sky-950/20'
						: 'border-neutral-800/80'}"
				>
					<div class="flex items-baseline justify-between gap-3">
						<label class="flex cursor-pointer items-baseline gap-2">
							<input
								type="checkbox"
								class="accent-sky-600"
								checked={on}
								onchange={() => toggle(c.lemma)}
							/>
							<span class="font-jp text-lg text-neutral-100">
								{c.surface}
								{#if c.reading && c.reading !== c.surface}
									<span class="ml-2 text-sm text-neutral-500">{c.reading}</span>
								{/if}
								{#if toRomaji(c.reading ?? c.surface) !== c.surface}
									<span class="ml-2 font-mono text-[10px] text-neutral-600">
										{toRomaji(c.reading ?? c.surface)}
									</span>
								{/if}
							</span>
						</label>
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

					<div class="mt-2">
						<button
							class="rounded border border-neutral-800 px-2 py-0.5 font-mono text-xs text-neutral-500
								hover:bg-neutral-800/50 disabled:opacity-40"
							disabled={busy !== null}
							onclick={() => skip(c.lemma)}
						>
							skip
						</button>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</aside>
