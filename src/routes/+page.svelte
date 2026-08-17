<script lang="ts">
	import { onMount } from 'svelte';
	import Line from '$lib/components/Line.svelte';
	import DefinitionPanel from '$lib/components/DefinitionPanel.svelte';
	import NamePanel from '$lib/components/NamePanel.svelte';
	import SessionPanel from '$lib/components/SessionPanel.svelte';
	import { loadTokenizer, type Token } from '$lib/tokenize';
	import type { SessionStats } from '$lib/stats';

	type StoredLine = {
		id: number;
		seq: number;
		kind: 'dialogue' | 'narration';
		speaker: string | null;
		text: string;
		received_at: number;
	};

	let lines = $state<StoredLine[]>([]);
	let connected = $state(false);
	let dictReady = $state(false);
	let dictError = $state<string | null>(null);
	let furiganaMode = $state<'none' | 'narration' | 'all'>('narration');
	let selected = $state<{ token: Token; lineId: number } | null>(null);
	let names = $state<{ surface: string; reading: string | null; seen_count: number }[]>([]);
	let showNames = $state(false);
	let showSession = $state(false);
	let session = $state<{ id: number; mode: string; startedAt: number } | null>(null);
	let stats = $state<SessionStats | null>(null);
	let viewport = $state<HTMLDivElement | null>(null);

	const narrationCount = $derived(lines.filter((l) => l.kind === 'narration').length);

	function scrollToEnd() {
		requestAnimationFrame(() => viewport?.scrollTo({ top: viewport.scrollHeight }));
	}

	onMount(() => {
		// ~18MB of dictionary. Kicked off here rather than per line so the first
		// line to arrive is not the one that pays for it.
		loadTokenizer()
			.then(() => (dictReady = true))
			.catch((e) => (dictError = String(e)));

		refreshSession();
		// Cheap, and only while the panel is closed does it not matter -- the point
		// is that the numbers are never stale enough to mislead.
		const poll = setInterval(refreshSession, 60_000);

		fetch('/api/names')
			.then((r) => r.json())
			.then((d) => (names = d.names))
			.catch(() => {});

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

		return () => {
			clearInterval(poll);
			es.close();
		};
	});

	async function refreshSession() {
		try {
			const d = await (await fetch('/api/session')).json();
			session = d.session;
			stats = d.stats;
		} catch {
			// The reader must keep working when telemetry does not.
		}
	}

	async function setMode(mode: string) {
		await fetch('/api/session', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ mode })
		}).catch(() => {});
		refreshSession();
	}

	const MODES = ['none', 'narration', 'all'] as const;
</script>

<svelte:head>
	<title>yomu</title>
</svelte:head>

<div class="mx-auto flex h-screen max-w-3xl flex-col">
	<header class="flex items-center justify-between border-b border-neutral-800 px-6 py-3">
		<h1 class="font-mono text-sm tracking-widest text-neutral-500 uppercase">yomu</h1>

		<div class="flex items-center gap-4 font-mono text-xs text-neutral-600">
			<div class="flex overflow-hidden rounded border border-neutral-800">
				{#each MODES as mode (mode)}
					<button
						class="px-2 py-0.5 {furiganaMode === mode
							? 'bg-neutral-800 text-neutral-200'
							: 'hover:text-neutral-400'}"
						onclick={() => (furiganaMode = mode)}
					>
						{mode}
					</button>
				{/each}
			</div>

			<button
				class="hover:text-neutral-400 {names.some((n) => !n.reading) ? 'text-amber-600/80' : ''}"
				onclick={() => (showNames = !showNames)}
			>
				names{names.some((n) => !n.reading) ? ` (${names.filter((n) => !n.reading).length})` : ''}
			</button>

			<button class="hover:text-neutral-400" onclick={() => (showSession = !showSession)}>
				session
			</button>

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

	{#if !dictReady}
		<p class="border-b border-neutral-900 px-6 py-2 font-mono text-xs text-amber-600/80">
			{dictError ? `dictionary failed: ${dictError}` : 'loading dictionary…'}
		</p>
	{/if}

	<div bind:this={viewport} class="flex-1 space-y-5 overflow-y-auto px-6 py-8">
		{#if lines.length === 0}
			<p class="mt-24 text-center font-mono text-sm text-neutral-600">
				Waiting for text. Start the bridge and advance a line.
			</p>
		{/if}

		{#each lines as line (line.id)}
			<Line
				id={line.id}
				kind={line.kind}
				speaker={line.speaker}
				text={line.text}
				{furiganaMode}
				{names}
				onlookup={(token, lineId) => (selected = { token, lineId })}
			/>
		{/each}
	</div>

	{#if showSession}
		<SessionPanel {session} {stats} onmode={setMode} onclose={() => (showSession = false)} />
	{:else if showNames}
		<NamePanel {names} onchange={(n) => (names = n)} onclose={() => (showNames = false)} />
	{:else if selected}
		<DefinitionPanel token={selected.token} onclose={() => (selected = null)} />
	{/if}
</div>
