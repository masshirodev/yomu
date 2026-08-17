import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dictionaryAvailable, lookup } from '$lib/server/dict';

/**
 * Definition lookup for a clicked token.
 *
 * Browser-only, so it sits behind Authentik with the reader rather than taking
 * the ingest token.
 */
export const GET: RequestHandler = ({ url }) => {
	const lemma = url.searchParams.get('lemma') ?? '';
	const surface = url.searchParams.get('surface') ?? undefined;
	const reading = url.searchParams.get('reading') ?? undefined;

	if (!lemma && !surface) error(400, 'expected lemma or surface');
	if (!dictionaryAvailable()) error(503, 'dictionary not built — run scripts/build-dict.js');

	return json({ entries: lookup(lemma, surface, reading) });
};
