<script lang="ts">
	import '../app.css';

	let { children } = $props();
</script>

<div class="min-h-full bg-neutral-950 text-neutral-100">
	{@render children()}
</div>
