import type { RequestHandler } from './$types';
import { subscribe } from '$lib/server/bus';
import { currentSession, recentLines } from '$lib/server/db';

/**
 * Server-sent events, not a WebSocket: this is strictly one-directional and SSE
 * reconnects on its own, which matters when the reader sits open for hours.
 */
export const GET: RequestHandler = () => {
	let unsubscribe = () => {};

	const stream = new ReadableStream({
		start(controller) {
			const enc = new TextEncoder();
			const send = (event: string, data: unknown) => {
				controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
			};

			// Replay so a reload does not lose the scrollback.
			send('backlog', recentLines(currentSession()));

			unsubscribe = subscribe((lines) => send('lines', lines));

			// Proxies drop idle connections; Caddy is in front of this in production.
			const keepAlive = setInterval(() => controller.enqueue(enc.encode(': ping\n\n')), 25_000);
			controller.enqueue(enc.encode(': open\n\n'));

			return () => clearInterval(keepAlive);
		},
		cancel() {
			unsubscribe();
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-store',
			connection: 'keep-alive'
		}
	});
};
