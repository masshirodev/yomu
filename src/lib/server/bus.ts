import type { StoredLine, WorkId } from './db';

/**
 * In-process fan-out from the ingest endpoint to connected readers.
 *
 * A single reader on a single box does not need Redis, a queue, or a second
 * process. If yomu ever runs more than one instance this becomes a real
 * pub/sub -- until then, extra machinery would be cost without benefit.
 */
type Listener = (lines: StoredLine[]) => void;

/**
 * Subscriptions carry the work they are watching.
 *
 * Without it a line from one visual novel is pushed into the reader showing
 * another -- the fan-out has no idea what it is relaying, and a reader with two
 * stories open would interleave them.
 */
const listeners = new Set<{ workId: WorkId; fn: Listener }>();

export function subscribe(workId: WorkId, fn: Listener): () => void {
	const entry = { workId, fn };
	listeners.add(entry);
	return () => listeners.delete(entry);
}

export function publish(workId: WorkId, lines: StoredLine[]): void {
	if (lines.length === 0) return;
	for (const { workId: watching, fn } of listeners) {
		if (watching !== workId) continue;
		try {
			fn(lines);
		} catch {
			// A dead reader must not break ingest. The stream endpoint drops its
			// own listener on close; this only catches the race in between.
		}
	}
}
