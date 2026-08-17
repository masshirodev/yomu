import { env } from '$env/dynamic/private';

/**
 * Pushing mined cards into Lattice.
 *
 * Lattice already has the whole SRS -- notes, cards, reviews, decks, a due
 * index and a review UI. Rebuilding any of that here would be duplicating a
 * working scheduler for no reason, so yomu decides *what* is worth studying and
 * Lattice decides *when*.
 */

const BASE = env.LATTICE_URL ?? 'https://lattice.masshiro.pro';

export type NoteInput = { front: string; back: string; tags: string; deckId?: string };

export class LatticeError extends Error {}

/**
 * Create a flashcard note. Returns its id.
 *
 * Failure is surfaced rather than swallowed: a mined word that silently never
 * arrived is worse than one that visibly failed, because the friction log has
 * already been marked decided and nothing would ever offer it again.
 */
export async function createNote(note: NoteInput): Promise<string> {
	const token = env.LATTICE_TOKEN;
	if (!token) throw new LatticeError('LATTICE_TOKEN is not configured');

	const res = await fetch(`${BASE}/api/flashcards/notes`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${token}`
		},
		body: JSON.stringify({
			front: note.front,
			back: note.back,
			tags: note.tags,
			noteType: 'basic',
			...(note.deckId ? { deckId: note.deckId } : {})
		})
	});

	if (!res.ok) {
		throw new LatticeError(`lattice rejected the note (${res.status}): ${await res.text()}`);
	}

	const body = await res.json();
	const id = body?.note?.id ?? body?.id;
	if (typeof id !== 'string') throw new LatticeError('lattice returned no note id');
	return id;
}

export function latticeConfigured(): boolean {
	return Boolean(env.LATTICE_TOKEN);
}
