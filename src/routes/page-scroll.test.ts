import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A guard for a bug a comment already failed to prevent.
 *
 * The reader's line list is `flex-col-reverse` so the scroll anchors to the
 * newest line. `justify-end` was added next to it to keep a short list pinned
 * to the top, and that made the list unscrollable: when a flex container's
 * content overflows, the excess sits past the axis start, and justify-content
 * moves that start outside the scrollable region.
 *
 * It survived review and development because it only fails once there is enough
 * text to scroll -- which is precisely when scrolling begins to matter, and
 * never during a three-line smoke test. A comment saying "do not do this" was
 * already there in spirit; this fails instead of being read past.
 */
const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('the reader viewport', () => {
	const viewport = source
		.split('\n')
		.find((l) => l.includes('flex-col-reverse') && l.includes('overflow-y-auto'));

	it('exists and scrolls', () => {
		expect(viewport).toBeDefined();
	});

	it('carries no justify-content, which would make the overflow unreachable', () => {
		expect(viewport).not.toMatch(/\bjustify-/u);
	});

	it('still anchors to the newest line', () => {
		expect(viewport).toMatch(/\bflex-col-reverse\b/u);
	});
});
