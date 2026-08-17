import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

/**
 * Shared-secret guard for the machine-to-machine endpoints.
 *
 * The reader UI sits behind Authentik forward-auth at the edge, but the bridge
 * posts from the machine running the game and cannot complete an interactive
 * login. Those paths therefore bypass Authentik in Caddy, which means they have
 * to carry their own guard here -- otherwise ingest would be an open write
 * endpoint on the public internet.
 */
export function requireIngestToken(request: Request): void {
	const expected = env.YOMU_INGEST_TOKEN;

	if (!expected) {
		// Refusing is the only safe default. Silently allowing unauthenticated
		// writes because a variable was forgotten is exactly how this becomes an
		// open endpoint without anyone noticing.
		if (env.NODE_ENV === 'production') error(503, 'YOMU_INGEST_TOKEN is not configured');
		return;
	}

	const header = request.headers.get('authorization') ?? '';
	const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';

	if (!timingSafeEqual(supplied, expected)) error(401, 'bad or missing ingest token');
}

/**
 * Constant-time comparison. Overkill for a homelab, but a length-dependent early
 * return is the kind of thing that is embarrassing to explain later and free to
 * avoid now.
 */
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}
