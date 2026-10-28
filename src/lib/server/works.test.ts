import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The works layer against a real database.
 *
 * db.ts opens its file at import time and runs the migration as a side effect,
 * so each case gets a fresh path and a fresh module registry. That is heavier
 * than a pure unit test and it is the point: the thing most likely to be wrong
 * here is a SQL predicate, and a mock would agree with whatever I wrote.
 */
let dir: string;

async function freshDb() {
	// Under the repository's temp/, not /tmp, which is RAM on the workstation.
	mkdirSync('temp', { recursive: true });
	dir = mkdtempSync(join('temp', 'yomu-works-'));
	process.env.YOMU_DB = join(dir, 'test.db');
	vi.resetModules();
	return await import('./db');
}

afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('scoping by work', () => {
	it('keeps two stories out of each other', async () => {
		const db = await freshDb();

		const a = db.ensureWork('vn-a', 'Story A');
		const b = db.ensureWork('vn-b', 'Story B');
		expect(a).not.toBe(b);

		const sa = db.currentSession(a);
		const sb = db.currentSession(b);
		expect(sa).not.toBe(sb);

		db.appendLines(sa, 'clipboard', [{ kind: 'narration', speaker: null, text: 'Aの一行目。' }], 1);
		db.appendLines(sb, 'clipboard', [{ kind: 'narration', speaker: null, text: 'Bの一行目。' }], 2);

		expect(db.recentLines(a).map((l) => l.text)).toEqual(['Aの一行目。']);
		expect(db.recentLines(b).map((l) => l.text)).toEqual(['Bの一行目。']);
		expect(db.contextLines(a)).toHaveLength(1);
	});

	it('gives each work its own names, so a cast cannot leak', async () => {
		const db = await freshDb();
		const a = db.ensureWork('vn-a');
		const b = db.ensureWork('vn-b');

		db.noteName(a, '桜羽エマ', 1);
		db.setNameReading(a, '桜羽エマ', 'さくらばえま');
		db.noteName(b, '別のキャラ', 2);

		expect(db.listNames(a).map((n) => n.surface)).toEqual(['桜羽エマ']);
		expect(db.listNames(b).map((n) => n.surface)).toEqual(['別のキャラ']);
		expect(db.listNames(a)[0].reading).toBe('さくらばえま');
		// The same surface in two works is two rows, not one shared row.
		db.noteName(b, '桜羽エマ', 3);
		expect(db.listNames(b).find((n) => n.surface === '桜羽エマ')?.reading).toBeNull();
	});

	it('lets the same word be mined separately in each work', async () => {
		const db = await freshDb();
		const a = db.ensureWork('vn-a');
		const b = db.ensureWork('vn-b');

		db.recordDecision(a, '諦める', 'approved', 'note-a');
		expect(db.miningCounts(a)).toEqual({ approved: 1, rejected: 0 });
		// Deciding it in one story must not retire it from the other's queue.
		expect(db.miningCounts(b)).toEqual({ approved: 0, rejected: 0 });

		db.recordDecision(b, '諦める', 'rejected', null);
		expect(db.miningCounts(a).approved).toBe(1);
		expect(db.miningCounts(b).rejected).toBe(1);
	});

	it('numbers seq per work so it survives a session rollover', async () => {
		const db = await freshDb();
		const a = db.ensureWork('vn-a');

		const first = db.currentSession(a, 1000);
		db.appendLines(first, 'clipboard', [{ kind: 'narration', speaker: null, text: '一。' }], 1000);

		// Far enough ahead that the session rolls over.
		const later = 1000 + 40 * 60_000;
		const second = db.currentSession(a, later);
		expect(second).not.toBe(first);
		db.appendLines(
			second,
			'clipboard',
			[{ kind: 'narration', speaker: null, text: '二。' }],
			later
		);

		// seq used to restart at 0 here, which made the spoiler boundary compare a
		// fact learned at line 900 against a line numbered 0.
		expect(db.recentLines(a).map((l) => l.seq)).toEqual([0, 1]);
	});

	it('shows the tail of a work across sessions, not just the open one', async () => {
		const db = await freshDb();
		const a = db.ensureWork('vn-a');

		const first = db.currentSession(a, 1000);
		db.appendLines(
			first,
			'clipboard',
			[{ kind: 'narration', speaker: null, text: '昨日。' }],
			1000
		);

		// A new session has no lines of its own. Backlog was scoped to it, so
		// opening the reader after a break showed an empty screen.
		const later = 1000 + 40 * 60_000;
		db.currentSession(a, later);

		expect(db.recentLines(a).map((l) => l.text)).toEqual(['昨日。']);
	});

	it('resolves the current work as the one read most recently', async () => {
		const db = await freshDb();
		const a = db.ensureWork('vn-a');
		const b = db.ensureWork('vn-b');

		db.appendLines(
			db.currentSession(a),
			'clipboard',
			[{ kind: 'narration', speaker: null, text: 'A。' }],
			1000
		);
		db.appendLines(
			db.currentSession(b),
			'clipboard',
			[{ kind: 'narration', speaker: null, text: 'B。' }],
			5000
		);

		expect(db.currentWork().slug).toBe('vn-b');
	});

	it('normalises slugs rather than trusting what a bridge sends', async () => {
		const db = await freshDb();
		const id = db.ensureWork('  Some VN! ', 'Some VN');
		expect(db.listWorks().find((w) => w.id === id)?.slug).toBe('some-vn');
		// The same messy input resolves to the same work rather than a second one.
		expect(db.ensureWork('some-vn')).toBe(id);
	});
});
