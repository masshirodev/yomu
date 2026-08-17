import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SESSION_IDLE_MS, type AdvanceSample, type LookupSample } from '$lib/stats';
import type { LookupRecord } from '$lib/mining';

const DB_PATH = process.env.YOMU_DB ?? 'data/yomu.db';

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  -- Dwell is only meaningful when it is known what the session was. A skim
  -- recorded as reading teaches the Phase 5 model that everything is known,
  -- which is exactly inverted. Never let an untagged session feed the model.
  mode        TEXT NOT NULL DEFAULT 'unknown'
                CHECK (mode IN ('reading', 'skimming', 'unknown'))
);

CREATE TABLE IF NOT EXISTS lines (
  id          INTEGER PRIMARY KEY,
  session_id  INTEGER NOT NULL REFERENCES sessions(id),
  seq         INTEGER NOT NULL,
  source      TEXT    NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('dialogue', 'narration')),
  speaker     TEXT,
  text        TEXT    NOT NULL,
  -- Client clock, not the server's. The reader is what the human is looking at.
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lines_session_seq ON lines(session_id, seq);

-- Phase 2. Written from day one and read by nothing yet, because dwell cannot
-- be collected retroactively -- every uninstrumented session is lost forever.
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY,
  session_id  INTEGER NOT NULL REFERENCES sessions(id),
  line_id     INTEGER REFERENCES lines(id),
  type        TEXT    NOT NULL,
  payload     TEXT,
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, at);

-- Character names, so the tokenizer stops splitting them. Discovered
-- automatically from the speaker thread; the reading needs a human, because
-- JMnedict offers four readings for 桜羽 and eight for 橘 and picks the wrong
-- one here. Confidently wrong is worse than absent for something the reader
-- sees on nearly every line.
CREATE TABLE IF NOT EXISTS names (
  surface    TEXT PRIMARY KEY,
  reading    TEXT,
  seen_count INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL
);

-- Mining decisions. A lemma appears here once it has been approved or rejected,
-- so a word turned down does not keep resurfacing every session and a word
-- already mined is never offered twice.
CREATE TABLE IF NOT EXISTS mining (
  lemma      TEXT PRIMARY KEY,
  status     TEXT NOT NULL CHECK (status IN ('approved', 'rejected')),
  decided_at INTEGER NOT NULL,
  note_id    TEXT
);
`);

export function openSession(now = Date.now()): number {
	const r = db.prepare('INSERT INTO sessions (started_at) VALUES (?)').run(now);
	return Number(r.lastInsertRowid);
}

/**
 * The open session, rolling over to a new one after a long enough gap.
 *
 * Without this a session never ends, so "this session" eventually spans weeks
 * and every derived statistic becomes an average over unrelated evenings.
 */
export function currentSession(now = Date.now()): number {
	const row = db
		.prepare(
			`SELECT s.id AS id,
			        COALESCE(MAX(l.received_at), s.started_at) AS last_at
			 FROM sessions s
			 LEFT JOIN lines l ON l.session_id = s.id
			 WHERE s.ended_at IS NULL
			 GROUP BY s.id
			 ORDER BY s.id DESC
			 LIMIT 1`
		)
		.get() as { id: number; last_at: number } | undefined;

	if (!row) return openSession(now);

	if (now - row.last_at > SESSION_IDLE_MS) {
		db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(row.last_at, row.id);
		return openSession(now);
	}

	return row.id;
}

export function setSessionMode(sessionId: number, mode: 'reading' | 'skimming' | 'unknown'): void {
	db.prepare('UPDATE sessions SET mode = ? WHERE id = ?').run(mode, sessionId);
}

/**
 * Dwell comes from `lines.received_at`, which is the clipboard timestamp taken
 * on the machine running the game -- the moment the line actually appeared.
 * That is a better clock than anything the browser could report, and it keeps
 * working when the reader is not open. Deliberately the only source of truth
 * for timing.
 */
export function sessionSamples(sessionId: number): {
	advances: AdvanceSample[];
	lookups: LookupSample[];
} {
	const advances = db
		.prepare('SELECT received_at AS at, LENGTH(text) AS length FROM lines WHERE session_id = ?')
		.all(sessionId) as AdvanceSample[];

	const lookups = (
		db
			.prepare("SELECT payload, at FROM events WHERE session_id = ? AND type = 'lookup'")
			.all(sessionId) as { payload: string | null; at: number }[]
	).flatMap((r) => {
		if (!r.payload) return [];
		try {
			const lemma = JSON.parse(r.payload).lemma;
			return typeof lemma === 'string' ? [{ lemma, at: r.at }] : [];
		} catch {
			return [];
		}
	});

	return { advances, lookups };
}

/**
 * Every lookup ever recorded, for candidate ranking.
 *
 * Deliberately not limited to the current session: a word met again weeks later
 * is the strongest evidence there is that it never stuck.
 */
export function allLookups(): LookupRecord[] {
	const rows = db
		.prepare(
			`SELECT e.payload AS payload, e.at AS at, e.session_id AS sessionId, e.line_id AS lineId
			 FROM events e
			 WHERE e.type = 'lookup'
			   AND e.payload IS NOT NULL
			   AND json_extract(e.payload, '$.lemma') NOT IN (SELECT lemma FROM mining)`
		)
		.all() as { payload: string; at: number; sessionId: number; lineId: number | null }[];

	return rows.flatMap((r) => {
		try {
			const p = JSON.parse(r.payload);
			if (typeof p.lemma !== 'string' || !p.lemma) return [];
			return [
				{
					lemma: p.lemma,
					surface: typeof p.surface === 'string' ? p.surface : p.lemma,
					pos: typeof p.pos === 'string' ? p.pos : '',
					sessionId: r.sessionId,
					at: r.at,
					lineId: r.lineId
				}
			];
		} catch {
			return [];
		}
	});
}

export function lineById(id: number): { text: string; speaker: string | null } | null {
	return (
		(db.prepare('SELECT text, speaker FROM lines WHERE id = ?').get(id) as {
			text: string;
			speaker: string | null;
		}) ?? null
	);
}

export function recordDecision(
	lemma: string,
	status: 'approved' | 'rejected',
	noteId: string | null,
	at = Date.now()
): void {
	db.prepare(
		`INSERT INTO mining (lemma, status, decided_at, note_id) VALUES (?, ?, ?, ?)
		 ON CONFLICT(lemma) DO UPDATE SET status = excluded.status,
		                                  decided_at = excluded.decided_at,
		                                  note_id = excluded.note_id`
	).run(lemma, status, at, noteId);
}

export function miningCounts(): { approved: number; rejected: number } {
	const rows = db.prepare('SELECT status, COUNT(*) AS n FROM mining GROUP BY status').all() as {
		status: string;
		n: number;
	}[];
	return {
		approved: rows.find((r) => r.status === 'approved')?.n ?? 0,
		rejected: rows.find((r) => r.status === 'rejected')?.n ?? 0
	};
}

export function sessionInfo(sessionId: number): { id: number; mode: string; started_at: number } {
	return db.prepare('SELECT id, mode, started_at FROM sessions WHERE id = ?').get(sessionId) as {
		id: number;
		mode: string;
		started_at: number;
	};
}

export type StoredLine = {
	id: number;
	seq: number;
	kind: 'dialogue' | 'narration';
	speaker: string | null;
	text: string;
	received_at: number;
};

const insertLine = db.prepare(
	`INSERT INTO lines (session_id, seq, source, kind, speaker, text, received_at)
	 VALUES (@session_id, @seq, @source, @kind, @speaker, @text, @received_at)`
);

const nextSeq = db.prepare(
	'SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM lines WHERE session_id = ?'
);

export function appendLines(
	sessionId: number,
	source: string,
	lines: { kind: 'dialogue' | 'narration'; speaker: string | null; text: string }[],
	receivedAt: number
): StoredLine[] {
	const stored: StoredLine[] = [];
	const write = db.transaction(() => {
		let seq = (nextSeq.get(sessionId) as { n: number }).n;
		for (const line of lines) {
			const r = insertLine.run({
				session_id: sessionId,
				seq,
				source,
				kind: line.kind,
				speaker: line.speaker,
				text: line.text,
				received_at: receivedAt
			});
			stored.push({ id: Number(r.lastInsertRowid), seq, ...line, received_at: receivedAt });
			seq += 1;
		}
	});
	write();
	return stored;
}

const insertEvent = db.prepare(
	`INSERT INTO events (session_id, line_id, type, payload, at)
	 VALUES (?, ?, ?, ?, ?)`
);

export function recordEvent(
	sessionId: number,
	lineId: number | null,
	type: string,
	payload: unknown,
	at: number
): void {
	insertEvent.run(sessionId, lineId, type, payload === null ? null : JSON.stringify(payload), at);
}

const upsertName = db.prepare(
	`INSERT INTO names (surface, reading, seen_count, first_seen)
	 VALUES (?, NULL, 1, ?)
	 ON CONFLICT(surface) DO UPDATE SET seen_count = seen_count + 1`
);

/** Record a speaker sighting. The reading is left for a human to supply. */
export function noteName(surface: string, at: number): void {
	if (surface) upsertName.run(surface, at);
}

export type NameRow = { surface: string; reading: string | null; seen_count: number };

export function listNames(): NameRow[] {
	return db
		.prepare('SELECT surface, reading, seen_count FROM names ORDER BY seen_count DESC, surface')
		.all() as NameRow[];
}

export function setNameReading(surface: string, reading: string | null): void {
	db.prepare('UPDATE names SET reading = ? WHERE surface = ?').run(reading || null, surface);
}

export function recentLines(sessionId: number, limit = 200): StoredLine[] {
	return db
		.prepare(
			`SELECT id, seq, kind, speaker, text, received_at
			 FROM lines WHERE session_id = ? ORDER BY seq DESC LIMIT ?`
		)
		.all(sessionId, limit)
		.reverse() as StoredLine[];
}
