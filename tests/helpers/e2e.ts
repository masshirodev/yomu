import type { Page } from '@playwright/test';

/**
 * Waits until the client has taken over the page: the root layout marks
 * `<html data-hydrated>` from an effect, which runs only once hydration is
 * done. Never wait for `networkidle` instead: a page that was idle once counts
 * as idle from then on, so it passes before the client is there (Kata D169).
 */
export async function ready(page: Page) {
	await page.locator('html[data-hydrated="true"]').waitFor();
}
