<script lang="ts">
	import { track } from '$lib/telemetry';
	import MixedText from './MixedText.svelte';
	import type { Token } from '$lib/tokenize';

	type Explanation = {
		grammar: { point: string; explanation: string }[];
		voice: string | null;
		reference: string | null;
		translation: string;
	};

	type Props = {
		lineId: number;
		text: string;
		onclose: () => void;
		onlookup: (token: Token) => void;
	};
	let { lineId, text, onclose, onlookup }: Props = $props();

	let explanation = $state<Explanation | null>(null);
	let failed = $state<string | null>(null);
	let showTranslation = $state(false);

	$effect(() => {
		let cancelled = false;
		explanation = null;
		failed = null;
		showTranslation = false;

		fetch('/api/explain', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ lineId })
		})
			.then(async (r) => {
				if (!r.ok) throw new Error(await r.text());
				return r.json();
			})
			.then((d) => {
				if (!cancelled) explanation = d.explanation;
			})
			.catch((e) => {
				if (!cancelled) failed = String(e);
			});

		return () => {
			cancelled = true;
		};
	});

	function reveal() {
		// Logged deliberately. Reading the whole VN through English translations
		// is the documented way this kind of tool fails, and the log is what makes
		// that visible instead of invisible.
		track('reveal', lineId, { length: text.length });
		showTranslation = true;
	}
</script>

<aside class="max-h-[50vh] overflow-y-auto border-t border-neutral-800 bg-neutral-900/80 px-6 py-4">
	<div class="flex items-baseline justify-between gap-4">
		<p class="font-jp text-base text-neutral-300">{text}</p>
		<button class="font-mono text-xs text-neutral-600 hover:text-neutral-400" onclick={onclose}>
			close
		</button>
	</div>

	{#if failed}
		<p class="mt-3 font-mono text-xs text-amber-600/80">{failed}</p>
	{:else if !explanation}
		<p class="mt-3 font-mono text-xs text-neutral-600">thinking…</p>
	{:else}
		{#if explanation.grammar.length}
			<ol class="mt-3 space-y-2">
				{#each explanation.grammar as g, i (i)}
					<li class="text-sm">
						<span class="font-jp text-sky-400"><MixedText text={g.point} {onlookup} /></span>
						<span class="ml-2 text-neutral-300"><MixedText text={g.explanation} {onlookup} /></span>
					</li>
				{/each}
			</ol>
		{/if}

		{#if explanation.voice}
			<p class="mt-3 text-sm text-neutral-400">
				<span class="font-mono text-[10px] tracking-wider text-neutral-600 uppercase">voice</span>
				<span class="ml-2"><MixedText text={explanation.voice} {onlookup} /></span>
			</p>
		{/if}

		{#if explanation.reference}
			<p class="mt-1 text-sm text-neutral-400">
				<span class="font-mono text-[10px] tracking-wider text-neutral-600 uppercase"
					>refers to</span
				>
				<span class="ml-2"><MixedText text={explanation.reference} {onlookup} /></span>
			</p>
		{/if}

		<div class="mt-4 border-t border-neutral-800/60 pt-3">
			{#if showTranslation}
				<p class="text-sm text-neutral-400">{explanation.translation}</p>
			{:else}
				<button
					class="rounded border border-neutral-800 px-2 py-1 font-mono text-xs text-neutral-500
						hover:bg-neutral-800/50 hover:text-neutral-300"
					onclick={reveal}
				>
					show English translation
				</button>
				<p class="mt-1 font-mono text-[10px] text-neutral-700">
					Deliberately a second click, and logged. Reading a VN through the translation is how this
					kind of tool quietly stops teaching anything.
				</p>
			{/if}
		</div>
	{/if}
</aside>
