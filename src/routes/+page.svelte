<script lang="ts">
	import { onMount } from 'svelte';
	import Line from '$lib/components/Line.svelte';
	import DefinitionPanel from '$lib/components/DefinitionPanel.svelte';
	import NamePanel from '$lib/components/NamePanel.svelte';
	import ExplainPanel from '$lib/components/ExplainPanel.svelte';
	import AttemptPanel from '$lib/components/AttemptPanel.svelte';
	import SessionPanel from '$lib/components/SessionPanel.svelte';
	import MiningPanel from '$lib/components/MiningPanel.svelte';
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
	let showMining = $state(false);
	let explaining = $state<{ lineId: number; text: string; span: string | null } | null>(null);
	/** A phrase the reader has selected by dragging across the text. */
	let phrase = $state<{ lineId: number; text: string; span: string } | null>(null);
	let checking = $state<{ lineId: number; text: string } | null>(null);
	let session = $state<{ id: number; mode: string; startedAt: number } | null>(null);
	let stats = $state<SessionStats | null>(null);
	let viewport = $state<HTMLDivElement | null>(null);

	const narrationCount = $derived(lines.filter((l) => l.kind === 'narration').length);

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
		});

		es.addEventListener('lines', (e) => {
			lines = [...lines, ...JSON.parse((e as MessageEvent).data)];
		});

		es.onerror = () => (connected = false);
		es.onopen = () => (connected = true);

		return () => {
			clearInterval(poll);
			es.close();
		};
	});

	/**
	 * Turn a text selection into a phrase to explain.
	 *
	 * Uses the browser's own selection rather than custom drag handling across
	 * tokens: `rt { user-select: none }` keeps furigana out of the selected text,
	 * so what comes back is exactly the base characters that were dragged over.
	 * Single clicks collapse the selection and are untouched, so click-to-define
	 * still works as before.
	 */
	function onSelection() {
		const sel = window.getSelection();
		const raw = sel?.toString().trim() ?? '';

		// One character is a click or a slip, not a phrase worth a model call.
		if (!sel || sel.isCollapsed || raw.length < 2) {
			phrase = null;
			return;
		}

		const node = sel.anchorNode;
		const el = (node instanceof Element ? node : node?.parentElement)?.closest('[data-line-id]');
		const id = el ? Number((el as HTMLElement).dataset.lineId) : NaN;
		const line = lines.find((l) => l.id === id);

		// The selection must sit inside one line and be part of its text; a drag
		// spanning two lines is not a phrase.
		phrase = line && line.text.includes(raw) ? { lineId: id, text: line.text, span: raw } : null;
	}

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

			<button class="hover:text-neutral-400" onclick={() => (showMining = !showMining)}>
				mine
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

	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<!-- Reversed column, not reversed reading order.
	     The DOM holds the newest line first and CSS flips it back, so the text
	     still reads downward while the browser anchors the scroll to the visual
	     bottom. Opening or closing a panel resizes this container, and without
	     the anchor every line slides -- which is the jump you get when clicking a
	     kana. It also makes "stay on the newest line" free, with no scroll
	     patching after each render.

	     Never put justify-content on this element. It was justify-end for a
	     while, to keep a short list pinned to the top of the screen, and that
	     silently broke scrolling: a flex container whose content overflows puts
	     the excess past the axis start, and justify-content moves that start out
	     of the scrollable region, so the overflow cannot be reached at all. It
	     looked fine throughout development because three test lines never
	     overflow -- it only failed once there was enough text to actually scroll,
	     which is the exact moment scrolling starts to matter. -->
	<div
		bind:this={viewport}
		class="flex flex-1 flex-col-reverse gap-5 overflow-y-auto px-6 py-8"
		onmouseup={onSelection}
		ontouchend={onSelection}
		role="document"
	>
		{#if lines.length === 0}
			<p class="my-auto text-center font-mono text-sm text-neutral-600">
				Waiting for text. Start the bridge and advance a line.
			</p>
		{/if}

		{#each [...lines].reverse() as line (line.id)}
			<Line
				id={line.id}
				kind={line.kind}
				speaker={line.speaker}
				text={line.text}
				{furiganaMode}
				{names}
				onlookup={(token, lineId) => {
					selected = { token, lineId };
					explaining = null;
				}}
				onexplain={(lineId, text) => {
					explaining = { lineId, text, span: null };
					selected = null;
					checking = null;
				}}
				oncheck={(lineId, text) => {
					checking = { lineId, text };
					explaining = null;
					selected = null;
				}}
			/>
		{/each}
	</div>

	{#if checking}
		<div class:hidden={selected !== null}>
			<AttemptPanel
				lineId={checking.lineId}
				text={checking.text}
				onclose={() => (checking = null)}
				onlookup={(token) => (selected = { token, lineId: checking!.lineId })}
			/>
		</div>
	{/if}

	{#if phrase && !explaining && !selected && !checking}
		<!-- Offered rather than fired automatically: selecting text is also just
		     how you read carefully, and a model call on every drag would be both
		     expensive and startling. -->
		<div class="flex items-center gap-3 border-t border-neutral-800 bg-neutral-900/80 px-6 py-2">
			<span class="font-jp text-sm text-sky-300">{phrase.span}</span>
			<button
				class="rounded border border-sky-800/60 px-2 py-0.5 font-mono text-xs text-sky-400
					hover:bg-sky-900/30"
				onclick={() => {
					explaining = { lineId: phrase!.lineId, text: phrase!.text, span: phrase!.span };
					phrase = null;
				}}
			>
				explain this phrase
			</button>
			<button
				class="font-mono text-xs text-neutral-600 hover:text-neutral-400"
				onclick={() => (phrase = null)}>dismiss</button
			>
		</div>
	{/if}

	{#if explaining}
		<!-- Kept mounted while a definition is open on top of it: unmounting would
		     re-run the fetch and flash "thinking…" again for an answer already in
		     hand. Hidden rather than removed, so going back is instant. -->
		<div class:hidden={selected !== null}>
			<ExplainPanel
				lineId={explaining.lineId}
				text={explaining.text}
				span={explaining.span}
				onclose={() => (explaining = null)}
				onlookup={(token) => (selected = { token, lineId: explaining!.lineId })}
			/>
		</div>
	{/if}

	{#if selected}
		<DefinitionPanel
			token={selected.token}
			onback={explaining || checking ? () => (selected = null) : null}
			onclose={() => {
				selected = null;
				explaining = null;
				checking = null;
			}}
		/>
	{:else if showMining}
		<MiningPanel onclose={() => (showMining = false)} />
	{:else if showSession}
		<SessionPanel {session} {stats} onmode={setMode} onclose={() => (showSession = false)} />
	{:else if showNames}
		<NamePanel {names} onchange={(n) => (names = n)} onclose={() => (showNames = false)} />
	{/if}
</div>
