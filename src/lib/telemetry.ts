/**
 * Client-side friction log.
 *
 * The whole premise of yomu is that what you looked up is better evidence of
 * what you do not know than any frequency list. That only holds if the log is
 * complete, so sending is fire-and-forget and never blocks or interrupts
 * reading -- a dropped event is far cheaper than a stutter that changes how the
 * reading itself goes.
 */
export type EventType = 'lookup' | 'explain' | 'reveal' | 'advance' | 'dwell';

export function track(type: EventType, lineId: number | null, payload?: unknown): void {
	const body = JSON.stringify({ type, lineId, payload, at: Date.now() });

	// sendBeacon survives the page being closed mid-session, which a fetch does
	// not. Reading sessions end by closing the tab far more often than by any
	// deliberate action.
	const blob = new Blob([body], { type: 'application/json' });
	if (navigator.sendBeacon?.('/api/events', blob)) return;

	void fetch('/api/events', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body,
		keepalive: true
	}).catch(() => {
		// Losing one event must never surface as an error to someone mid-sentence.
	});
}
