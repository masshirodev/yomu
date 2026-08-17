import { describe, expect, it } from 'vitest';
import { dwellSamples, summarise, IDLE_CAP_MS, type AdvanceSample } from './stats';

/** Lines arriving at a fixed cadence, each the same length. */
const cadence = (gapMs: number, count: number, length = 35): AdvanceSample[] =>
	Array.from({ length: count }, (_, i) => ({ at: 1_000_000 + i * gapMs, length }));

describe('dwellSamples', () => {
	it('caps a gap so an absence does not read as concentration', () => {
		// The real capture contained a 531s gap: mash went away, not deep in thought.
		const samples = dwellSamples([
			{ at: 0, length: 30 },
			{ at: 531_000, length: 30 },
			{ at: 534_000, length: 30 }
		]);
		expect(samples[0].ms).toBe(IDLE_CAP_MS);
		expect(samples[1].ms).toBe(3000);
	});

	it('gives the last line no dwell, since its duration is unknown', () => {
		expect(dwellSamples(cadence(5000, 3))).toHaveLength(2);
	});

	it('tolerates out-of-order arrivals', () => {
		const samples = dwellSamples([
			{ at: 2000, length: 10 },
			{ at: 1000, length: 10 }
		]);
		expect(samples).toEqual([{ ms: 1000, length: 10 }]);
	});
});

describe('summarise', () => {
	it('classifies the real Phase 0 capture as skimming', () => {
		// 197 events, median gap 2.25s, ~35-char lines. Confirmed click-through by
		// hand at the time -- this is the calibration case, not a guess.
		const stats = summarise(cadence(2250, 197), []);
		expect(stats.inferredMode).toBe('skimming');
		expect(stats.secondsPerChar).toBeCloseTo(0.064, 2);
	});

	it('classifies a plausible learner pace as reading', () => {
		// ~12s on a 35-character sentence: slow, which is the point.
		const stats = summarise(cadence(12_000, 40), []);
		expect(stats.inferredMode).toBe('reading');
	});

	it('refuses to guess from too few lines', () => {
		expect(summarise(cadence(12_000, 5), []).inferredMode).toBe('unknown');
	});

	it('normalises by length, so short exclamations are not mistaken for skimming', () => {
		// 「え？」 read in 1.5s is attentive; the same gap on a 40-char line is not.
		const short = summarise(cadence(1500, 30, 3), []);
		expect(short.inferredMode).toBe('reading');

		const long = summarise(cadence(1500, 30, 40), []);
		expect(long.inferredMode).toBe('skimming');
	});

	it('counts re-lookups separately from first lookups', () => {
		const stats = summarise(cadence(8000, 25), [
			{ lemma: '蔑む', at: 1 },
			{ lemma: '鉄格子', at: 2 },
			{ lemma: '蔑む', at: 3 },
			{ lemma: '蔑む', at: 4 }
		]);
		expect(stats.lookups).toBe(4);
		expect(stats.uniqueLemmas).toBe(2);
		expect(stats.relookups).toBe(2);
	});

	it('excludes idle time from the active total', () => {
		const stats = summarise(
			[
				{ at: 0, length: 30 },
				{ at: 600_000, length: 30 },
				{ at: 605_000, length: 30 }
			],
			[]
		);
		// Ten minutes away contributes the cap, not ten minutes.
		expect(stats.activeMs).toBe(IDLE_CAP_MS + 5000);
	});

	it('handles an empty session without dividing by zero', () => {
		const stats = summarise([], []);
		expect(stats).toMatchObject({
			lines: 0,
			activeMs: 0,
			medianDwellMs: null,
			inferredMode: 'unknown'
		});
	});
});
