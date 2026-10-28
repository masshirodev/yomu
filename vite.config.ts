import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter()
		})
	],
	// The dev port stays in the `dev` script, where it has always been; preview
	// gets its own so it never meets a running dev server (AGENTS.local.md).
	preview: { port: 42149, strictPort: true },
	test: {
		// The floor (doc/TESTING.md, "Coverage"): what src/lib held when yomu was
		// adopted by hajime, the lowest of the four metrics rounded down. Over
		// src/lib, where the logic lives: a route is a page, held by the design
		// sweep instead. Raise it, never lower it.
		coverage: {
			provider: 'v8',
			include: ['src/lib/**/*.{ts,svelte}'],
			exclude: ['src/lib/**/*.{test,spec}.ts', 'src/lib/**/*.d.ts'],
			thresholds: { lines: 38, branches: 38, functions: 38, statements: 38 }
		}
	}
});
