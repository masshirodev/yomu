import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
`);

export function openSession(now = Date.now()): number {
	const r = db.prepare('INSERT INTO sessions (started_at) VALUES (?)').run(now);
	return Number(r.lastInsertRowid);
}

export function currentSession(now = Date.now()): number {
	const row = db
		.prepare('SELECT id FROM sessions WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1')
		.get() as { id: number } | undefined;
	return row?.id ?? openSession(now);
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
