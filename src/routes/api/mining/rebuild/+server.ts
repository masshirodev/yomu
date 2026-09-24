import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	characterFacts,
	contextLines,
	lineById,
	lineWithSeq,
	listNames,
	markCardFormat,
	minedWords,
	storyDigests
} from '$lib/server/db';
import { lookup } from '$lib/server/dict';
import { buildContext, renderContext } from '$lib/context';
import { furigana } from 'kotoba';
import { annotateSentence, composeCard, type Enrichment, type SentenceToken } from 'kotoba';
import { buildEnrichPrompt, matchEnrichments } from '$lib/enrich';
import { latticeConfigured, LatticeError, updateNote } from '$lib/server/lattice';
import { explainConfigured, runProvider } from '$lib/server/explain';
import { resolveWork } from '$lib/server/work';

/**
 * Rebuild cards that were already sent.
 *
 * The first cards this project made were entirely Japanese and carried no
 * readings, because the card format could not hold them and Lattice could not
 * render them. Both are fixed, and the cards already in the deck are not --
 * they are exactly the words met first, so they are the ones most likely to
 * still be in learning.
 *
 * Rewriting the note leaves the schedule beside it alone, so a card rebuilt
 * half way through keeps every review it has earned. That is the whole reason
 * this exists rather than "delete them and mine them again".
 */

const MAX_BATCH = 6;

/** The mined words and the sentences they were met in, for the client to tokenise. */
export const GET: RequestHandler = ({ url }) => {
	const work = resolveWork(url.searchParams.get('work'));
	return json({
		words: minedWords(work.id).map((w) => {
			const line = w.lineId === null ? null : lineById(w.lineId);
			return { ...w, sentence: line?.text ?? null, speaker: line?.speaker ?? null };
		}),
		ready: latticeConfigured()
	});
};

export const POST: RequestHandler = async ({ request, url }) => {
	const body = await request.json().catch(() => null);
	const work = resolveWork(body?.work ?? url.searchParams.get('work'));
	const items = Array.isArray(body?.items) ? body.items : null;
	if (!items?.length) error(400, 'expected { items: [{ lemma, tokens }] }');
	if (items.length > MAX_BATCH) error(400, `at most ${MAX_BATCH} words at a time`);

	const tokensByLemma = new Map<string, SentenceToken[]>();
	for (const it of items) {
		if (typeof it?.lemma !== 'string') error(400, 'each item needs a lemma');
		tokensByLemma.set(it.lemma, Array.isArray(it.tokens) ? it.tokens : []);
	}

	const selected = minedWords(work.id).filter((w) => tokensByLemma.has(w.lemma));
	if (!selected.length) error(404, 'none of those are mined words');

	const names = listNames(work.id);

	const prepared = selected.map((w) => {
		const line = w.lineId === null ? null : lineById(w.lineId);
		const [entry] = lookup(w.lemma, w.surface);
		// Names are not in JMdict, but the name thread recorded how they are read.
		// Without this 桜羽エマ got no reading at all and its romaji line came out
		// as the literal string 桜羽ema.
		const reading = entry?.kana?.[0] ?? names.find((n) => n.surface === w.lemma)?.reading ?? null;
		const tokens = tokensByLemma.get(w.lemma) ?? [];

		return {
			word: w,
			reading,
			glosses: entry?.senses?.[0]?.gloss ?? [],
			sentence: line?.text ?? null,
			speaker: line?.speaker ?? null,
			annotated: tokens.length ? annotateSentence(tokens, furigana, names) : (line?.text ?? null),
			wordSegments: furigana(w.lemma, reading)
		};
	});

	const seqs = prepared
		.map((p) => (p.word.lineId === null ? null : lineWithSeq(p.word.lineId)?.seq))
		.filter((s): s is number => typeof s === 'number');

	// Same read-position boundary as everywhere else. Rebuilding a card for a word
	// met in line 2 must not explain it with anything from line 400.
	const context = seqs.length
		? renderContext(
				buildContext({
					currentSeq: Math.max(...seqs),
					digests: storyDigests(work.id),
					facts: characterFacts(work.id),
					lines: contextLines(work.id)
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
						lemma: p.word.lemma,
						surface: p.word.surface,
						glosses: p.glosses,
						sentence: p.sentence,
						speaker: p.speaker
					})),
					context,
					names,
					furigana
				),
				'words'
			);
			const { matched, unmatched } = matchEnrichments(
				prepared.map((p) => ({ lemma: p.word.lemma, surface: p.word.surface })),
				reply.words ?? []
			);
			enrichments = matched;
			// Said out loud. Unmatched words still get a card, just a thin one, and
			// a thin card that nothing reports is the worst way for this to fail.
			if (unmatched.length) failure = `no enrichment matched: ${unmatched.join(', ')}`;
		} catch (e) {
			failure = e instanceof Error ? e.message : String(e);
		}
	} else {
		failure = 'no enrichment provider configured';
	}

	const rebuilt: string[] = [];
	const failed: { lemma: string; error: string }[] = [];
	const skipped: string[] = [];

	for (const p of prepared) {
		const enrichment = enrichments.get(p.word.lemma) ?? null;

		// A card that already exists is only replaced by a better one. Without this
		// a provider timeout rewrote all eleven cards from the dictionary alone --
		// losing every translation and note -- and then stamped them current, so
		// nothing would ever have offered them again. Leaving them untouched costs
		// one retry; overwriting them costs the content.
		if (!enrichment) {
			skipped.push(p.word.lemma);
			continue;
		}

		const card = composeCard({
			lemma: p.word.lemma,
			reading: p.reading,
			wordSegments: p.wordSegments,
			glosses: p.glosses,
			speaker: p.speaker,
			annotatedSentence: p.annotated,
			sentenceTranslation: null,
			tags: `yomu,${work.slug}`,
			enrichment
		});

		try {
			await updateNote(p.word.noteId, card);
			// Stamped only after Lattice confirms, so a card that failed to update
			// stays on the list instead of being quietly marked done.
			markCardFormat(work.id, p.word.lemma);
			rebuilt.push(p.word.lemma);
		} catch (e) {
			failed.push({
				lemma: p.word.lemma,
				error: e instanceof LatticeError ? e.message : String(e)
			});
		}
	}

	return json({
		ok: failed.length === 0 && skipped.length === 0,
		rebuilt,
		failed,
		skipped,
		error: failure
	});
};
