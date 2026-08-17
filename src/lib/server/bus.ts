import type { StoredLine } from './db';

/**
 * In-process fan-out from the ingest endpoint to connected readers.
 *
 * A single reader on a single box does not need Redis, a queue, or a second
 * process. If yomu ever runs more than one instance this becomes a real
 * pub/sub -- until then, extra machinery would be cost without benefit.
 */
type Listener = (lines: StoredLine[]) => void;

const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

export function publish(lines: StoredLine[]): void {
	if (lines.length === 0) return;
	for (const fn of listeners) {
		try {
			fn(lines);
		} catch {
			// A dead reader must not break ingest. The stream endpoint drops its
			// own listener on close; this only catches the race in between.
		}
	}
}
