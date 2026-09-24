import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import {
	allLookups,
	deleteDraft,
	draftByLemma,
	lineById,
	listDrafts,
	miningCounts,
	recordDecision
} from '$lib/server/db';
import { lookup } from '$lib/server/dict';
import { createNote, latticeConfigured, LatticeError } from '$lib/server/lattice';
import { rankCandidates } from 'kotoba';
import { resolveWork } from '$lib/server/work';
import { composeCard } from 'kotoba';
import { furigana } from 'kotoba';

const MAX_CANDIDATES = 40;

/**
 * Mining candidates, ranked by friction.
 *
 * Everything here is a proposal. Nothing is created without an explicit
 * approval, because auto-mining floods a deck and kills the review habit inside
 * a week -- which costs far more than the handful of words a human filter drops.
 */
export const GET: RequestHandler = ({ url }) => {
	const work = resolveWork(url.searchParams.get('work'));
	const ranked = rankCandidates(allLookups(work.id)).slice(0, MAX_CANDIDATES);

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
		drafts: listDrafts(work.id),
		counts: miningCounts(work.id),
		latticeReady: latticeConfigured()
	});
};

export const POST: RequestHandler = async ({ request, url }) => {
	const body = await request.json().catch(() => null);
	const work = resolveWork(body?.work ?? url.searchParams.get('work'));

	// Creating the enriched batch. Each card is sent on its own and reported on
	// its own: a batch that fails halfway must say which words got through, or
	// the only safe response is to resend everything and duplicate the rest.
	if (body?.action === 'create') {
		const lemmas: string[] = Array.isArray(body.lemmas) ? body.lemmas : [];
		if (!lemmas.length) error(400, 'expected { action: "create", lemmas }');

		const created: string[] = [];
		const failed: { lemma: string; error: string }[] = [];

		for (const lemma of lemmas) {
			const draft = draftByLemma(work.id, lemma);
			if (!draft) {
				failed.push({ lemma, error: 'no draft; enrich it first' });
				continue;
			}

			try {
				const noteId = await createNote({
					front: draft.front,
					back: draft.back,
					tags: draft.tags,
					deckId: env.YOMU_LATTICE_DECK
				});
				// Same order as the single-word path: Lattice confirms, then the word
				// is retired from the queue, then the draft is spent.
				recordDecision(work.id, lemma, 'approved', noteId);
				deleteDraft(work.id, lemma);
				created.push(lemma);
			} catch (e) {
				failed.push({ lemma, error: e instanceof Error ? e.message : String(e) });
			}
		}

		return json({ ok: failed.length === 0, created, failed, counts: miningCounts(work.id) });
	}

	if (!body || typeof body.lemma !== 'string') error(400, 'expected { lemma, action }');

	if (body.action === 'reject') {
		recordDecision(work.id, body.lemma, 'rejected', null);
		// A skipped word must not leave an enriched draft behind, or it reappears in
		// the review list having already been decided against.
		deleteDraft(work.id, body.lemma);
		return json({ ok: true, counts: miningCounts(work.id) });
	}

	if (body.action !== 'approve') error(400, 'action must be approve or reject');

	const [candidate] = rankCandidates(allLookups(work.id)).filter((c) => c.lemma === body.lemma);
	if (!candidate) error(404, 'no such candidate');

	const line = candidate.lineId === null ? null : lineById(candidate.lineId);
	const [entry] = lookup(candidate.lemma, candidate.surface);

	// The quick path: no provider call, so no meaning-in-context and no
	// annotated sentence -- the tokenizer that would furigana it runs in the
	// browser. Readings on the word itself still come through, which is the
	// difference between a card you can read and one you cannot.
	const reading = entry?.kana?.[0] ?? null;
	const card = composeCard({
		lemma: candidate.lemma,
		reading,
		wordSegments: furigana(candidate.lemma, reading),
		glosses: entry?.senses?.[0]?.gloss ?? [],
		speaker: line?.speaker ?? null,
		annotatedSentence: line?.text ?? null,
		sentenceTranslation: null,
		enrichment: null,
		tags: `yomu,${work.slug}`
	});

	try {
		const noteId = await createNote({ ...card, deckId: env.YOMU_LATTICE_DECK });
		// Recorded only after Lattice confirms. Marking it decided first would mean
		// a failed push silently retires the word from the queue forever.
		recordDecision(work.id, candidate.lemma, 'approved', noteId);
		return json({ ok: true, noteId, counts: miningCounts(work.id) });
	} catch (e) {
		if (e instanceof LatticeError) error(502, e.message);
		throw e;
	}
};
