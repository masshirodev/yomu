import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { currentWork, ensureWork, listWorks } from '$lib/server/db';

/**
 * The visual novels yomu knows about.
 *
 * Ordered by what was read most recently, which is also how the reader picks a
 * default: with one VN this is invisible machinery, and with two the most
 * recently read is almost always the one meant.
 */
export const GET: RequestHandler = () => json({ works: listWorks(), current: currentWork().slug });

/** Create one by hand, for a VN whose bridge has not sent a line yet. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (typeof body?.slug !== 'string' || !body.slug.trim()) error(400, 'expected { slug, title }');

	ensureWork(body.slug, typeof body.title === 'string' ? body.title : undefined);
	return json({ works: listWorks() });
};
