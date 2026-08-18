<script lang="ts">
	import { parseBrackets } from '$lib/enrich';

	/**
	 * A draft card rendered the way Lattice will render it.
	 *
	 * Ruby is built in the template rather than through {@html}, so card text is
	 * escaped by Svelte as usual and this component cannot become an injection
	 * point no matter what a provider returns.
	 */
	type Props = { text: string };
	let { text }: Props = $props();

	const segments = $derived(parseBrackets(text));
</script>

<p class="font-jp text-sm leading-loose whitespace-pre-wrap text-neutral-300">
	{#each segments as s, i (i)}{#if s.ruby}<ruby
				>{s.text}<rt class="text-[0.55em] text-neutral-500">{s.ruby}</rt></ruby
			>{:else}{s.text}{/if}{/each}
</p>
