<script lang="ts">
	import '../app.css';

	let { children } = $props();

	// The browser tests wait for this rather than for the network to go quiet:
	// a page idle once counts as idle from then on, so `networkidle` passes
	// before the client has taken over (Kata D169). tests/helpers/e2e.ts reads it.
	$effect(() => {
		document.documentElement.dataset.hydrated = 'true';
	});
</script>

<div class="min-h-full bg-neutral-950 text-neutral-100">
	{@render children()}
</div>
