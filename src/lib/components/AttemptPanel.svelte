<script lang="ts">
	type Verdict = {
		gist: 'correct' | 'partial' | 'missed';
		got: string[];
		missed: string[];
		note: string;
	};

	type Props = { lineId: number; text: string; onclose: () => void };
	let { lineId, text, onclose }: Props = $props();

	let guess = $state('');
	let submitted = $state<string | null>(null);
	let verdict = $state<Verdict | null>(null);
	let failed = $state<string | null>(null);
	let busy = $state(false);
	let box = $state<HTMLTextAreaElement | null>(null);

	// Reset only when the line changes.
	//
	// Focusing must NOT happen in here. Reading `box` would make this effect
	// depend on it, and submitting destroys the textarea -- bind:this then sets
	// box to null, the effect re-runs, and it wipes `submitted` and `guess` a
	// moment after the verdict arrives. That is the whole answer disappearing
	// with the input cleared, which is exactly what it did.
	$effect(() => {
		void lineId;
		guess = '';
		submitted = null;
		verdict = null;
		failed = null;
	});

	// Separate effect: reads box, writes nothing, so it cannot reset anything.
	$effect(() => {
		box?.focus();
	});

	async function submit() {
		const value = guess.trim();
		if (!value || busy) return;

		busy = true;
		failed = null;
		// Shown as committed the moment it is sent. The answer appears only after,
		// which is the whole point: guessing against a visible answer teaches
		// nothing, guessing and then being corrected is the part that works.
		submitted = value;

		try {
			const res = await fetch('/api/attempt', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ lineId, guess: value })
			});
			if (!res.ok) throw new Error(await res.text());
			const d = await res.json();
			verdict = d.verdict;
			failed = d.error ?? null;
		} catch (e) {
			failed = String(e);
		} finally {
			busy = false;
		}
	}

	const TONE = {
		correct: 'text-emerald-400 border-emerald-800/60',
		partial: 'text-amber-400 border-amber-800/60',
		missed: 'text-rose-400 border-rose-800/60'
	} as const;
</script>

<aside class="max-h-[55vh] overflow-y-auto border-t border-neutral-700 bg-neutral-900 px-6 py-5">
	<div class="flex items-baseline justify-between gap-4">
		<p class="font-jp text-lg leading-relaxed text-neutral-300">{text}</p>
		<button
			class="shrink-0 font-mono text-xs text-neutral-600 hover:text-neutral-400"
			onclick={onclose}
		>
			close
		</button>
	</div>

	{#if !submitted}
		<p class="mt-3 font-mono text-xs text-neutral-500">
			What do you think it means? Write it rough — you are being marked on the Japanese, not the
			English.
		</p>
		<textarea
			bind:this={box}
			bind:value={guess}
			rows="2"
			placeholder="your best guess…"
			class="mt-2 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-base
				text-neutral-100 placeholder:text-neutral-600 focus:border-sky-700 focus:outline-none"
			onkeydown={(e) => {
				if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
			}}></textarea>
		<div class="mt-2 flex items-center gap-3">
			<button
				class="rounded border border-sky-800/60 px-3 py-1 font-mono text-xs text-sky-400
					hover:bg-sky-900/30 disabled:opacity-40"
				disabled={!guess.trim() || busy}
				onclick={submit}
			>
				check it
			</button>
			<span class="font-mono text-[11px] text-neutral-600">⌘/Ctrl + Enter</span>
		</div>
	{:else}
		<p class="mt-3 text-base text-neutral-300">
			<span class="font-mono text-xs tracking-wider text-neutral-500 uppercase">you said</span>
			<span class="ml-2">{submitted}</span>
		</p>

		{#if busy}
			<p class="mt-4 font-mono text-sm text-neutral-400">checking…</p>
		{:else if failed}
			<p class="mt-4 font-mono text-sm text-amber-600/80">
				Saved, but grading failed: {failed}
			</p>
		{:else if verdict}
			<div class="mt-4 rounded border px-3 py-2 {TONE[verdict.gist]}">
				<p class="font-mono text-xs tracking-wider uppercase">{verdict.gist}</p>
				<p class="mt-1 text-base leading-relaxed text-neutral-200">{verdict.note}</p>
			</div>

			{#if verdict.got.length}
				<div class="mt-3">
					<p class="font-mono text-xs tracking-wider text-emerald-600/80 uppercase">got</p>
					<ul class="mt-1 space-y-1">
						{#each verdict.got as g, i (i)}
							<li class="text-base leading-relaxed text-neutral-300">{g}</li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if verdict.missed.length}
				<div class="mt-3">
					<p class="font-mono text-xs tracking-wider text-rose-600/80 uppercase">missed</p>
					<ul class="mt-1 space-y-1">
						{#each verdict.missed as m, i (i)}
							<li class="text-base leading-relaxed text-neutral-300">{m}</li>
						{/each}
					</ul>
				</div>
			{/if}
		{/if}
	{/if}
</aside>
