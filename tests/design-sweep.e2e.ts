import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, test } from '@playwright/test';
import { sweep } from './helpers/sweep';

// The design sweep (doc/TESTING.md, "The design sweep"): every page, at a desk
// and a phone, held to the rules every new screen in Kumiko and Kata broke at
// least once:
//
//   - no `[object Object]`, `undefined` or `NaN` in what a person reads;
//   - no raw `{key}` in what a person reads;
//   - no page wider than the window;
//   - a card (helpers/sweep.ts, `CARD`) keeps its content 8 px off its edges;
//   - no error thrown in the page, and nothing logged as one.
//
// PAGES names a path to open for every route under src/routes. The first test
// fails when a route is added and named nowhere, so a new screen is swept from
// the day it lands: add it to PAGES in the commit that makes it, or to
// NOT_A_PAGE with why.

/** Route (as a folder under src/routes, '' for the root) to the paths to open. */
const PAGES: Record<string, string[]> = {
	'': ['/']
};

/** Routes the sweep does not open, each with why. */
const NOT_A_PAGE: Record<string, string> = {};

/** Pages too wide for a phone, on purpose and for now; only their width is let pass. */
const PHONE_TOO_WIDE = new Set<string>();

const WIDTHS = [
	{ name: 'desk', width: 1440, height: 900 },
	{ name: 'phone', width: 390, height: 844 }
];

/** Every folder under src/routes that holds a +page.svelte, as a route key. */
function routes(dir = 'src/routes'): string[] {
	const found: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) found.push(...routes(path));
		else if (name === '+page.svelte') found.push(relative('src/routes', dir).split(sep).join('/'));
	}
	return found.sort();
}

test('every route is swept or says why not', () => {
	const named = new Set([...Object.keys(PAGES), ...Object.keys(NOT_A_PAGE)]);
	expect(routes().filter((r) => !named.has(r))).toEqual([]);
	expect([...named].filter((r) => !routes().includes(r))).toEqual([]);
});

for (const { name, width, height } of WIDTHS)
	for (const [route, paths] of Object.entries(PAGES))
		for (const path of paths)
			test(`${path} at ${name} width`, async ({ page }) => {
				await page.setViewportSize({ width, height });
				const wideOk = name === 'phone' && PHONE_TOO_WIDE.has(route);
				expect(await sweep(page, path, false, wideOk)).toEqual([]);
			});
