<script lang="ts">
	type Stats = {
		lines: number;
		chars: number;
		activeMs: number;
		medianDwellMs: number | null;
		secondsPerChar: number | null;
		lookups: number;
		uniqueLemmas: number;
		relookups: number;
		inferredMode: 'reading' | 'skimming' | 'unknown';
	};
	type Session = { id: number; mode: string; startedAt: number };

	type Props = {
		session: Session | null;
		stats: Stats | null;
		onmode: (mode: string) => void;
		onclose: () => void;
	};
	let { session, stats, onmode, onclose }: Props = $props();

	const MODES = ['reading', 'skimming', 'unknown'] as const;

	const minutes = (ms: number) => `${Math.round(ms / 60000)}m`;
	const seconds = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`);
</script>

<aside class="border-t border-neutral-800 bg-neutral-900/80 px-6 py-4">
	<div class="flex items-baseline justify-between">
		<p class="font-mono text-xs tracking-wider text-neutral-400 uppercase">session</p>
		<button class="font-mono text-xs text-neutral-600 hover:text-neutral-400" onclick={onclose}>
			close
		</button>
	</div>

	{#if !stats || !session}
		<p class="mt-2 font-mono text-xs text-neutral-600">loading…</p>
	{:else}
		<dl class="mt-3 grid grid-cols-3 gap-x-6 gap-y-2 font-mono text-xs sm:grid-cols-6">
			{#each [['lines', String(stats.lines)], ['active', minutes(stats.activeMs)], ['median dwell', seconds(stats.medianDwellMs)], ['lookups', String(stats.lookups)], ['unique', String(stats.uniqueLemmas)], ['re-lookups', String(stats.relookups)]] as [label, value] (label)}
				<div>
					<dt class="text-neutral-600">{label}</dt>
					<dd class="text-neutral-200">{value}</dd>
				</div>
			{/each}
		</dl>

		<div class="mt-4 flex flex-wrap items-center gap-3">
			<span class="font-mono text-xs text-neutral-600">mode</span>

			<div class="flex overflow-hidden rounded border border-neutral-800 font-mono text-xs">
				{#each MODES as mode (mode)}
					<button
						class="px-2 py-0.5 {session.mode === mode
							? 'bg-neutral-800 text-neutral-200'
							: 'text-neutral-500 hover:text-neutral-300'}"
						onclick={() => onmode(mode)}
					>
						{mode}
					</button>
				{/each}
			</div>

			<span class="font-mono text-xs text-neutral-600">
				looks like <span class="text-neutral-400">{stats.inferredMode}</span>
				{#if stats.secondsPerChar !== null}
					({stats.secondsPerChar.toFixed(3)} s/char)
				{/if}
			</span>
		</div>

		<p class="mt-3 font-mono text-[10px] leading-relaxed text-neutral-600">
			Dwell is the gap between lines arriving, capped at two minutes so stepping away does not read
			as concentration. Nothing consumes this yet — it is recorded now because it cannot be
			recovered later, and a session tagged wrongly would teach the word model the opposite of the
			truth.
		</p>
	{/if}
</aside>
