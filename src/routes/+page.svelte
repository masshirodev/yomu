<script lang="ts">
	import { onMount } from 'svelte';

	type Line = {
		id: number;
		seq: number;
		kind: 'dialogue' | 'narration';
		speaker: string | null;
		text: string;
		received_at: number;
	};

	let lines = $state<Line[]>([]);
	let connected = $state(false);
	let viewport = $state<HTMLDivElement | null>(null);

	// Narration is the register with no listening scaffold behind it, so it is the
	// one that gets the visual weight. Dialogue is where mash is already strong.
	const narrationCount = $derived(lines.filter((l) => l.kind === 'narration').length);

	function scrollToEnd() {
		// Wait a frame so the new node is laid out before measuring.
		requestAnimationFrame(() => viewport?.scrollTo({ top: viewport.scrollHeight }));
	}

	onMount(() => {
		const es = new EventSource('/api/stream');

		es.addEventListener('backlog', (e) => {
			lines = JSON.parse((e as MessageEvent).data);
			connected = true;
			scrollToEnd();
		});

		es.addEventListener('lines', (e) => {
			lines = [...lines, ...JSON.parse((e as MessageEvent).data)];
			scrollToEnd();
		});

		es.onerror = () => (connected = false);
		es.onopen = () => (connected = true);

		return () => es.close();
	});
</script>

<svelte:head>
	<title>yomu</title>
</svelte:head>

<div class="mx-auto flex h-screen max-w-3xl flex-col">
	<header class="flex items-center justify-between border-b border-neutral-800 px-6 py-3">
		<h1 class="font-mono text-sm tracking-widest text-neutral-500 uppercase">yomu</h1>
		<div class="flex items-center gap-4 font-mono text-xs text-neutral-600">
			<span>{lines.length} lines &middot; {narrationCount} narration</span>
			<span class="flex items-center gap-1.5">
				<span
					class="inline-block h-1.5 w-1.5 rounded-full {connected
						? 'bg-emerald-500'
						: 'bg-neutral-700'}"
				></span>
				{connected ? 'live' : 'offline'}
			</span>
		</div>
	</header>

	<div bind:this={viewport} class="flex-1 space-y-5 overflow-y-auto px-6 py-8">
		{#if lines.length === 0}
			<p class="mt-24 text-center font-mono text-sm text-neutral-600">
				Waiting for text. Start the bridge and advance a line.
			</p>
		{/if}

		{#each lines as line (line.id)}
			<article class="font-jp">
				{#if line.speaker}
					<p class="mb-1 text-sm font-medium text-sky-400">{line.speaker}</p>
				{/if}
				<p
					class="text-2xl leading-loose {line.kind === 'narration'
						? 'text-neutral-300'
						: 'text-neutral-100'}"
				>
					{line.text}
				</p>
			</article>
		{/each}
	</div>
</div>
