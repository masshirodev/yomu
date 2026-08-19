import { currentWork, ensureWork, workBySlug, type WorkRow } from './db';

/**
 * Which visual novel a request is about.
 *
 * Every surface resolves this the same way: an explicit slug wins, otherwise
 * whichever work was read most recently. That default is what keeps the reader
 * a single-click tool for the usual case of having one VN open, while still
 * letting a second one exist.
 */
export function resolveWork(slug?: string | null): WorkRow {
	const named = slug?.trim() ? workBySlug(slug.trim()) : null;
	return named ?? currentWork();
}

/**
 * The work a line is being ingested into, creating it on first sight.
 *
 * Creating rather than rejecting is deliberate: the bridge is configured on the
 * machine playing the game, and the reader should not need a setup step before
 * text can arrive. An unknown slug means a new VN was started, which is exactly
 * when the least friction is wanted.
 */
export function workForIngest(slug?: string | null, title?: string | null): WorkRow {
	const clean = slug?.trim();
	if (!clean) return currentWork();
	ensureWork(clean, title?.trim() || clean);
	return workBySlug(clean)!;
}
