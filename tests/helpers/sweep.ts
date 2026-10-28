import type { ConsoleMessage, Page } from '@playwright/test';
import { ready } from './e2e';

// The design sweep's rules (doc/TESTING.md, "The design sweep"), after Kata's
// tests/helpers/sweep.ts and Kumiko's tests/design-system.e2e.ts: the rules every
// new screen there broke at least once.

/**
 * What counts as a card: a box that must keep its text and controls off its
 * edges. Change it to this app's own card class; `[data-card]` works for any
 * element that opts in. A card drawn to its edge on purpose carries `data-flush`.
 */
export const CARD = 'main [data-card]';

export interface Found {
	what: string;
	where: string;
}

/**
 * What the page breaks of the rules, read in the page. `keysAllowed`: whether a
 * raw `{key}` may appear in what a person reads (an editor that names keys on
 * purpose); a page for its users never shows one.
 */
export async function problems(page: Page, keysAllowed: boolean): Promise<Found[]> {
	return page.evaluate(
		([keysAllowed, cardSelector]) => {
			const out: { what: string; where: string }[] = [];
			const bad = /\[object Object\]|\bundefined\b|\bNaN\b/;
			const rawKey = /\{[a-z][a-z0-9_]*\}/;
			const name = (el: Element) =>
				`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${
					typeof el.className === 'string' && el.className
						? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
						: ''
				}`;
			// The browser's own answer: a closed <details> keeps its content laid out
			// (Chromium only skips painting it), and an ancestor may hide it too.
			const shown = (el: Element) =>
				el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
			// What a person reads: text nodes, and each box's value and hint.
			const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
			for (let n = walker.nextNode(); n; n = walker.nextNode()) {
				const parent = n.parentElement;
				if (!parent || !shown(parent) || parent.closest('script, style, template')) continue;
				const text = n.textContent ?? '';
				if (bad.test(text))
					out.push({ what: `reads "${text.trim().slice(0, 60)}"`, where: name(parent) });
				else if (!keysAllowed && rawKey.test(text) && !parent.closest('code'))
					out.push({ what: `a raw key "${text.trim().slice(0, 60)}"`, where: name(parent) });
			}
			for (const box of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
				'input:not([type=hidden]), textarea'
			)) {
				for (const said of [box.value, box.placeholder])
					if (bad.test(said ?? ''))
						out.push({ what: `a box holds "${said.slice(0, 60)}"`, where: name(box) });
			}
			// No page wider than the window.
			const over = document.documentElement.scrollWidth - window.innerWidth;
			if (over > 0) {
				// The elements where the overflow starts: past the edge, inside a parent that is not.
				const past = (el: Element) => el.getBoundingClientRect().right > window.innerWidth + 0.5;
				const wide = [...document.querySelectorAll('body *')]
					.filter((el) => shown(el) && past(el) && !(el.parentElement && past(el.parentElement)))
					.slice(0, 3)
					.map((el) => `${name(el)} ${Math.round(el.getBoundingClientRect().width)}px`)
					.join(', ');
				out.push({ what: `the page is ${over}px wider than the window`, where: wide });
			}
			// A card holds what it says off its own edges: the text and controls drawn
			// inside it start at least 8px in. A card that draws to its edge on purpose
			// (a preview, a table, a picture) says so with data-flush.
			for (const card of document.querySelectorAll(cardSelector)) {
				if (!shown(card) || card.closest('[data-flush]') || card.querySelector(':scope > table'))
					continue;
				const box = card.getBoundingClientRect();
				if (box.width < 40 || box.height < 20) continue;
				let nearest = Infinity;
				let culprit = '';
				// Content a box inside the card scrolls to (a wide table's `.r-tablebox`) is
				// clipped by that box on purpose: it is reached by scrolling, not cut. Text
				// is clipped by its own element too (a timeline's one-day bar cuts a long
				// title at its end), so for text the walk starts at the element holding it.
				const cuts = (r: DOMRect, a: Element) => {
					const c = a.getBoundingClientRect();
					return r.right > c.right + 0.5 || r.left < c.left - 0.5;
				};
				const clipped = (r: DOMRect, el: Element, text: boolean) => {
					if (text && el !== card && getComputedStyle(el).overflowX !== 'visible' && cuts(r, el))
						return true;
					for (let a = el.parentElement; a && a !== card; a = a.parentElement) {
						const o = getComputedStyle(a).overflowX;
						if (o === 'auto' || o === 'scroll' || o === 'hidden') {
							// A box that scrolls sideways cuts its content wherever the scroll
							// leaves it: how near that cut is to the card's edge means nothing.
							if (a.scrollWidth > a.clientWidth + 1) return true;
							return cuts(r, a);
						}
					}
					return false;
				};
				const near = (r: DOMRect, el: Element, text = false) => {
					if (!r.width || !r.height || clipped(r, el, text)) return;
					const d = Math.min(r.left - box.left, box.right - r.right, r.top - box.top);
					if (d < nearest) [nearest, culprit] = [d, name(el)];
				};
				const inside = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
				for (let n = inside.nextNode(); n; n = inside.nextNode()) {
					if (!n.textContent?.trim() || !n.parentElement || !shown(n.parentElement)) continue;
					const range = document.createRange();
					range.selectNodeContents(n);
					for (const r of range.getClientRects()) near(r, n.parentElement, true);
				}
				for (const c of card.querySelectorAll('input:not([type=hidden]), textarea, select, button'))
					if (shown(c)) near(c.getBoundingClientRect(), c);
				if (nearest < 8)
					out.push({
						what: `a card's content is ${Math.round(nearest)}px from its edge`,
						where: `${name(card)} > ${culprit}`
					});
			}
			return out;
		},
		[keysAllowed, CARD] as const
	);
}

/** Opens one page and returns what it breaks, its errors included. */
export async function sweep(
	page: Page,
	path: string,
	keysAllowed: boolean,
	wideOk = false
): Promise<string[]> {
	const errors: string[] = [];
	const onError = (e: Error) => errors.push(`throws: ${e.message.slice(0, 120)}`);
	const onConsole = (msg: ConsoleMessage) => {
		if (msg.type() === 'error' && !/favicon|Failed to load resource/.test(msg.text()))
			errors.push(`logs an error: ${msg.text().slice(0, 120)}`);
	};
	page.on('pageerror', onError);
	page.on('console', onConsole);
	const answer = await page.goto(path);
	await ready(page);
	const found = [
		...(answer && answer.status() >= 400 ? [`answers ${answer.status()}`] : []),
		...errors,
		...(await problems(page, keysAllowed))
			.filter((p) => !(wideOk && /wider than the window/.test(p.what)))
			.map((p) => `${p.what} (${p.where})`)
	];
	page.off('pageerror', onError);
	page.off('console', onConsole);
	return found;
}
