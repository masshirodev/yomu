/**
 * Which work the page is showing, as the client sees it.
 *
 * Read from the URL rather than passed down through every component: switching
 * work is a full page load, so the URL is the single source of truth for the
 * whole page and cannot drift from what the stream is sending.
 *
 * Absent means "whatever was read most recently", which the server resolves.
 * That is the right default with one VN and the usual one with several.
 */
export function currentWorkSlug(): string | null {
	if (typeof window === 'undefined') return null;
	return new URLSearchParams(window.location.search).get('work');
}

/** `?work=slug` or an empty string, for appending to an API path. */
export function workQuery(prefix = '?'): string {
	const slug = currentWorkSlug();
	return slug ? `${prefix}work=${encodeURIComponent(slug)}` : '';
}

/** Merge the work into a JSON body, so POSTs land on the story being read. */
export function withWork<T extends object>(body: T): T & { work?: string } {
	const slug = currentWorkSlug();
	return slug ? { ...body, work: slug } : body;
}
