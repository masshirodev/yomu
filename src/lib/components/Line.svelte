<script lang="ts">
	import { tokenize, type Token } from '$lib/tokenize';
	import { applyNames, type NameEntry } from '$lib/names';
	import { furigana } from '$lib/furigana';
	import { track } from '$lib/telemetry';

	type Props = {
		id: number;
		kind: 'dialogue' | 'narration';
		speaker: string | null;
		text: string;
		furiganaMode: 'none' | 'narration' | 'all';
		names: NameEntry[];
		onlookup: (token: Token, lineId: number) => void;
		onexplain: (lineId: number, text: string) => void;
	};

	let { id, kind, speaker, text, furiganaMode, names, onlookup, onexplain }: Props = $props();

	let tokens = $state<Token[] | null>(null);

	// Narration is the register with no listening scaffold behind it -- anime is
	// overwhelmingly dialogue -- so it gets readings by default while dialogue
	// stays clean. A line you can already hear does not need the help.
	const showFurigana = $derived(
		furiganaMode === 'all' || (furiganaMode === 'narration' && kind === 'narration')
	);

	$effect(() => {
		// Depends on names as well as text, so filling in a reading re-renders the
		// lines already on screen rather than only the next ones.
		const known = names;

		let cancelled = false;
		tokenize(text)
			.then((t) => {
				if (!cancelled) tokens = applyNames(t, known);
			})
			.catch(() => {
				// Fall back to unanalysed text rather than showing nothing. A line you
				// cannot click is still a line you can read.
				if (!cancelled) tokens = null;
			});
		return () => {
			cancelled = true;
		};
	});

	/**
	 * The speaker label is a lookup target too.
	 *
	 * It is the most frequently repeated name on screen and, until now, the only
	 * text in the reader you could not get a reading for -- which is backwards,
	 * because katakana names are exactly the recall gap romaji was added for.
	 * The curated reading from the names table is used when there is one, so this
	 * shows さくらばえま / sakurabaema rather than kuromoji's guess.
	 */
	function lookupSpeaker(name: string) {
		const known = names.find((n) => n.surface === name);
		lookup({
			surface: name,
			lemma: name,
			reading: known?.reading ?? null,
			pos: '名詞',
			segments: furigana(name, known?.reading ?? null),
			lookupable: true
		});
	}

	function lookup(token: Token) {
		if (!token.lookupable) return;
		track('lookup', id, { lemma: token.lemma, surface: token.surface, pos: token.pos });
		onlookup(token, id);
	}
</script>

<article class="group font-jp">
	<div class="mb-1 flex items-baseline gap-3">
		{#if speaker}
			<button
				class="text-sm font-medium text-sky-400 hover:text-sky-300 hover:underline"
				onclick={() => lookupSpeaker(speaker)}
			>
				{speaker}
			</button>
		{/if}
		<!-- Revealed on hover: an always-visible button per line would turn the
		     page into a wall of controls and pull the eye off the text. -->
		<button
			class="font-mono text-[10px] text-neutral-700 opacity-0 transition group-hover:opacity-100
				hover:text-sky-500 focus:opacity-100"
			onclick={() => onexplain(id, text)}
		>
			explain
		</button>
	</div>

	<p
		class="text-2xl {showFurigana ? 'leading-[2.6]' : 'leading-loose'} {kind === 'narration'
			? 'text-neutral-300'
			: 'text-neutral-100'}"
	>
		{#if tokens}
			{#each tokens as token, i (i)}
				{#if token.lookupable}
					<!-- A span rather than a button: there are dozens per line, and button
					     semantics would turn the page into a tab-stop minefield. -->
					<span
						role="button"
						tabindex="-1"
						class="cursor-pointer rounded-sm hover:bg-sky-500/20"
						onclick={() => lookup(token)}
						onkeydown={(e) => e.key === 'Enter' && lookup(token)}
					>
						{#each token.segments as seg, si (si)}
							{#if seg.ruby && showFurigana}
								<ruby>{seg.text}<rt class="text-[0.5em] text-neutral-500">{seg.ruby}</rt></ruby>
							{:else}{seg.text}{/if}
						{/each}
					</span>
				{:else}{token.surface}{/if}
			{/each}
		{:else}{text}{/if}
	</p>
</article>
