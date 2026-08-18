import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	allLookups,
	characterFacts,
	contextLines,
	currentSession,
	deleteDraft,
	lineById,
	lineWithSeq,
	listDrafts,
	listNames,
	saveDraft,
	storyDigests
} from '$lib/server/db';
import { lookup } from '$lib/server/dict';
import { buildContext } from '$lib/context';
import { renderContext } from '$lib/context';
import { furigana } from '$lib/furigana';
import {
	annotateSentence,
	buildEnrichPrompt,
	composeCard,
	type Enrichment,
	type SentenceToken
} from '$lib/enrich';
import { rankCandidates } from '$lib/mining';
import { explainConfigured, runProvider } from '$lib/server/explain';

/**
 * Enrich a selection of mined words into reviewable cards.
 *
 * Selection and enrichment are separated from creation on purpose. Approving
 * one word at a time meant deciding blind -- you saw a lemma and a gloss and had
 * to guess whether the card would be any good. Now the batch is enriched first
 * and shown as the cards it will actually become, and creating them is a second,
 * explicit step.
 *
 * The tokenizer runs in the browser (see `$lib/tokenize`), so the client sends
 * the sentence readings it already computed to display the line. That keeps the
 * 4-vCPU host out of a job it deliberately does not do, and costs nothing --
 * those readings were computed the moment the line was rendered.
 */

/** Enrichment is one provider call for the whole batch, so cap what one call carries. */
const MAX_BATCH = 12;

export const GET: RequestHandler = () => json({ drafts: listDrafts() });

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	const items = Array.isArray(body?.items) ? body.items : null;
	if (!items?.length) error(400, 'expected { items: [{ lemma, tokens }] }');
	if (items.length > MAX_BATCH) error(400, `at most ${MAX_BATCH} words at a time`);

	const ranked = rankCandidates(allLookups());
	const tokensByLemma = new Map<string, SentenceToken[]>();
	for (const it of items) {
		if (typeof it?.lemma !== 'string') error(400, 'each item needs a lemma');
		tokensByLemma.set(it.lemma, Array.isArray(it.tokens) ? it.tokens : []);
	}

	const selected = ranked.filter((c) => tokensByLemma.has(c.lemma));
	if (!selected.length) error(404, 'none of those are candidates');

	const prepared = selected.map((c) => {
		const line = c.lineId === null ? null : lineById(c.lineId);
		const [entry] = lookup(c.lemma, c.surface);
		const reading = entry?.kana?.[0] ?? null;
		const tokens = tokensByLemma.get(c.lemma) ?? [];

		return {
			candidate: c,
			reading,
			glosses: entry?.senses?.[0]?.gloss ?? [],
			sentence: line?.text ?? null,
			speaker: line?.speaker ?? null,
			// Annotated from the client's tokens. With none -- an older page, or a
			// word whose line predates the reader -- the sentence still goes on the
			// card, just without readings.
			annotated: tokens.length ? annotateSentence(tokens, furigana) : (line?.text ?? null),
			wordSegments: furigana(c.surface, reading)
		};
	});

	// The context boundary is the newest line any of these words was met in.
	// Enrichment may see everything read up to there and nothing after it, the
	// same rule explanations and grading follow.
	const seqs = prepared
		.map((p) => (p.candidate.lineId === null ? null : lineWithSeq(p.candidate.lineId)?.seq))
		.filter((s): s is number => typeof s === 'number');

	const context = seqs.length
		? renderContext(
				buildContext({
					currentSeq: Math.max(...seqs),
					digests: storyDigests(),
					facts: characterFacts(),
					lines: contextLines(currentSession())
				})
			)
		: '';

	let enrichments = new Map<string, Enrichment>();
	let failure: string | null = null;

	if (explainConfigured()) {
		try {
			const reply = await runProvider<{ words: (Enrichment & { lemma: string })[] }>(
				buildEnrichPrompt(
					prepared.map((p) => ({
						lemma: p.candidate.lemma,
						surface: p.candidate.surface,
						glosses: p.glosses,
						sentence: p.sentence,
						speaker: p.speaker
					})),
					context,
					listNames(),
					furigana
				),
				'words'
			);
			enrichments = new Map((reply.words ?? []).map((w) => [w.lemma, w]));
		} catch (e) {
			// A provider failure degrades to dictionary-only cards rather than losing
			// the selection. The words are still worth studying; they are just less
			// well explained, and re-enriching is one more click.
			failure = e instanceof Error ? e.message : String(e);
		}
	} else {
		failure = 'no enrichment provider configured';
	}

	const drafts = prepared.map((p) => {
		const draft = composeCard({
			lemma: p.candidate.lemma,
			surface: p.candidate.surface,
			reading: p.reading,
			wordSegments: p.wordSegments,
			glosses: p.glosses,
			speaker: p.speaker,
			annotatedSentence: p.annotated,
			sentenceTranslation: null,
			enrichment: enrichments.get(p.candidate.lemma) ?? null
		});
		saveDraft(draft);
		return draft;
	});

	return json({ drafts, enriched: enrichments.size, error: failure });
};

/** Drop a draft without deciding anything about the word itself. */
export const DELETE: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (typeof body?.lemma !== 'string') error(400, 'expected { lemma }');
	deleteDraft(body.lemma);
	return json({ ok: true });
};
