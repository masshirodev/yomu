<script lang="ts">
	import { withWork } from '$lib/work';
	import { toRomaji } from '$lib/romaji';

	type NameRow = { surface: string; reading: string | null; seen_count: number };

	type Props = { names: NameRow[]; onchange: (names: NameRow[]) => void; onclose: () => void };
	let { names, onchange, onclose }: Props = $props();

	let saving = $state<string | null>(null);

	async function save(surface: string, reading: string) {
		saving = surface;
		try {
			const res = await fetch('/api/names', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(withWork({ surface, reading }))
			});
			if (res.ok) onchange((await res.json()).names);
		} finally {
			saving = null;
		}
	}

	// Names without a reading first: those are the ones still costing something.
	const sorted = $derived(
		[...names].sort(
			(a, b) => Number(!!a.reading) - Number(!!b.reading) || b.seen_count - a.seen_count
		)
	);
</script>

<aside class="max-h-[42vh] overflow-y-auto border-t border-neutral-800 bg-neutral-900/80 px-6 py-4">
	<div class="flex items-baseline justify-between">
		<p class="font-mono text-xs tracking-wider text-neutral-400 uppercase">character names</p>
		<button class="font-mono text-xs text-neutral-600 hover:text-neutral-400" onclick={onclose}>
			close
		</button>
	</div>

	<p class="mt-1 font-mono text-[10px] text-neutral-600">
		Collected from the speaker thread. Readings are typed by hand — name dictionaries offer several
		readings per surname and pick the wrong one here.
	</p>

	{#if sorted.length === 0}
		<p class="mt-3 font-mono text-xs text-neutral-600">
			No names seen yet. They appear as characters introduce themselves.
		</p>
	{:else}
		<ul class="mt-3 space-y-1.5">
			{#each sorted as name (name.surface)}
				<li class="flex items-center gap-3">
					<span class="font-jp w-40 shrink-0 text-neutral-200">{name.surface}</span>
					<input
						class="font-jp w-48 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-sm
							text-neutral-200 placeholder:text-neutral-700 focus:border-sky-700 focus:outline-none"
						placeholder="reading in hiragana"
						value={name.reading ?? ''}
						onchange={(e) => save(name.surface, e.currentTarget.value)}
					/>
					{#if name.reading}
						<span class="font-mono text-[10px] text-neutral-600">{toRomaji(name.reading)}</span>
					{/if}
					<span class="font-mono text-[10px] text-neutral-600">
						{saving === name.surface ? 'saving…' : `${name.seen_count}×`}
					</span>
				</li>
			{/each}
		</ul>
	{/if}
</aside>
