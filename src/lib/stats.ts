/**
 * Derived reading statistics.
 *
 * Pure functions over the raw log so they can be tested against real captured
 * numbers rather than a fixture invented to agree with them.
 *
 * Dwell is derived rather than recorded: the time spent on a line is the gap
 * until the next line arrives, which the `advance` events already contain.
 * Recording it separately would add a second source of truth that could disagree
 * with the first.
 */

/** Beyond this, a gap is someone leaving, not someone reading. */
export const IDLE_CAP_MS = 120_000;

/**
 * A gap this long ends the session. Picked to be comfortably longer than
 * thinking hard about a sentence and comfortably shorter than a meal.
 */
export const SESSION_IDLE_MS = 30 * 60_000;

/**
 * Below this many seconds per character, nobody is reading -- they are
 * advancing. Calibrated against a Phase 0 capture that was confirmed by hand as
 * click-through: 197 events, median gap 2.25s over roughly 35-character lines,
 * which is 0.064 s/char. Learner-pace reading of Japanese prose runs several
 * times slower than that.
 */
export const SKIM_SECONDS_PER_CHAR = 0.15;

/** Too few lines to judge; claiming either mode would be noise. */
export const MIN_LINES_TO_INFER = 20;

export type AdvanceSample = {
	/** Client timestamp the line arrived. */
	at: number;
	/** Characters in the line, used to normalise dwell by how much there was to read. */
	length: number;
};

export type LookupSample = { lemma: string; at: number };

export type SessionStats = {
	lines: number;
	chars: number;
	/** Sum of dwells, each capped so an absence does not read as concentration. */
	activeMs: number;
	medianDwellMs: number | null;
	secondsPerChar: number | null;
	lookups: number;
	uniqueLemmas: number;
	/** Lookups of a lemma already looked up this session -- the strongest signal. */
	relookups: number;
	inferredMode: 'reading' | 'skimming' | 'unknown';
};

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Gaps between consecutive advances, capped.
 *
 * The last line has no successor and so contributes no dwell -- its duration is
 * genuinely unknown until something else happens.
 */
export function dwellSamples(advances: AdvanceSample[]): { ms: number; length: number }[] {
	const ordered = [...advances].sort((a, b) => a.at - b.at);
	const out: { ms: number; length: number }[] = [];

	for (let i = 0; i < ordered.length - 1; i++) {
		const gap = ordered[i + 1].at - ordered[i].at;
		if (gap <= 0) continue;
		out.push({ ms: Math.min(gap, IDLE_CAP_MS), length: ordered[i].length });
	}

	return out;
}

export function summarise(advances: AdvanceSample[], lookups: LookupSample[]): SessionStats {
	const dwells = dwellSamples(advances);
	const activeMs = dwells.reduce((sum, d) => sum + d.ms, 0);
	const chars = advances.reduce((sum, a) => sum + a.length, 0);

	// Normalise per character rather than per line: a session of one-word
	// exclamations and a session of dense narration are not comparable otherwise.
	const rated = dwells.filter((d) => d.length > 0).map((d) => d.ms / 1000 / d.length);
	const secondsPerChar = median(rated);

	const seen = new Set<string>();
	let relookups = 0;
	for (const l of [...lookups].sort((a, b) => a.at - b.at)) {
		if (seen.has(l.lemma)) relookups++;
		else seen.add(l.lemma);
	}

	let inferredMode: SessionStats['inferredMode'] = 'unknown';
	if (advances.length >= MIN_LINES_TO_INFER && secondsPerChar !== null) {
		inferredMode = secondsPerChar < SKIM_SECONDS_PER_CHAR ? 'skimming' : 'reading';
	}

	return {
		lines: advances.length,
		chars,
		activeMs,
		medianDwellMs: median(dwells.map((d) => d.ms)),
		secondsPerChar,
		lookups: lookups.length,
		uniqueLemmas: seen.size,
		relookups,
		inferredMode
	};
}
