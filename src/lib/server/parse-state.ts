import { emptyState, type ParseState } from '$lib/parse';

/**
 * Per-session parser carry-over.
 *
 * Held in memory rather than persisted: the only thing it carries is a speaker
 * name waiting for its line, which is meaningless once a session ends. Losing it
 * on restart costs at most one unattributed line.
 */
const states = new Map<number, ParseState>();

export function stateFor(sessionId: number): ParseState {
	return states.get(sessionId) ?? emptyState();
}

export function saveState(sessionId: number, state: ParseState): void {
	states.set(sessionId, state);
}
