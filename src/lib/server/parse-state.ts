import { emptyState, type ParseState } from '$lib/parse';
import { lastStoredLine } from './db';

/**
 * Per-session parser carry-over.
 *
 * Held in memory: a speaker name waiting for its line is meaningless once a
 * session ends, and losing it on restart costs at most one unattributed line.
 */
const states = new Map<number, ParseState>();

export function stateFor(sessionId: number): ParseState {
	const held = states.get(sessionId);
	if (held) return held;

	// The last line is read back from storage rather than started empty, because
	// the echo this most needs to catch is the game redrawing the line you
	// stopped on when you resume -- and that arrives in a *new* session, where
	// per-session carry-over is empty by definition. It also survives a restart,
	// which in-memory state does not.
	const last = lastStoredLine();
	return {
		...emptyState(),
		lastText: last?.text ?? null,
		lastAt: last?.received_at ?? 0
	};
}

export function saveState(sessionId: number, state: ParseState): void {
	states.set(sessionId, state);
}
