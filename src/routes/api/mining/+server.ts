import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { allLookups, lineById, miningCounts, recordDecision } from '$lib/server/db';
import { lookup } from '$lib/server/dict';
import { createNote, latticeConfigured, LatticeError } from '$lib/server/lattice';
import { formatCard, rankCandidates } from '$lib/mining';

const MAX_CANDIDATES = 40;

/**
 * Mining candidates, ranked by friction.
 *
 * Everything here is a proposal. Nothing is created without an explicit
 * approval, because auto-mining floods a deck and kills the review habit inside
 * a week -- which costs far more than the handful of words a human filter drops.
 */
export const GET: RequestHandler = () => {
	const ranked = rankCandidates(allLookups()).slice(0, MAX_CANDIDATES);

	const candidates = ranked.map((c) => {
		const line = c.lineId === null ? null : lineById(c.lineId);
		const [entry] = lookup(c.lemma, c.surface);

		return {
			...c,
			sentence: line?.text ?? null,
			speaker: line?.speaker ?? null,
			reading: entry?.kana?.[0] ?? null,
			glosses: entry?.senses?.[0]?.gloss ?? []
		};
	});

	return json({
		candidates,
		counts: miningCounts(),
		latticeReady: latticeConfigured()
	});
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (!body || typeof body.lemma !== 'string') error(400, 'expected { lemma, action }');

	if (body.action === 'reject') {
		recordDecision(body.lemma, 'rejected', null);
		return json({ ok: true, counts: miningCounts() });
	}

	if (body.action !== 'approve') error(400, 'action must be approve or reject');

	const [candidate] = rankCandidates(allLookups()).filter((c) => c.lemma === body.lemma);
	if (!candidate) error(404, 'no such candidate');

	const line = candidate.lineId === null ? null : lineById(candidate.lineId);
	const [entry] = lookup(candidate.lemma, candidate.surface);

	const card = formatCard({
		surface: candidate.surface,
		reading: entry?.kana?.[0] ?? null,
		glosses: entry?.senses?.[0]?.gloss ?? [],
		sentence: line?.text ?? null,
		speaker: line?.speaker ?? null
	});

	try {
		const noteId = await createNote({ ...card, deckId: env.YOMU_LATTICE_DECK });
		// Recorded only after Lattice confirms. Marking it decided first would mean
		// a failed push silently retires the word from the queue forever.
		recordDecision(candidate.lemma, 'approved', noteId);
		return json({ ok: true, noteId, counts: miningCounts() });
	} catch (e) {
		if (e instanceof LatticeError) error(502, e.message);
		throw e;
	}
};
