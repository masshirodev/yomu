import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SESSION_IDLE_MS, type AdvanceSample, type LookupSample } from '$lib/stats';
import type { LookupRecord } from '$lib/mining';
import type { CharacterFact, ContextLine, StoryDigest } from '$lib/context';

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

-- Phase 3 story memory. Every row is stamped with the line it was learned at,
-- and every read filters on that -- see src/lib/context.ts. A digest is a
-- compressed summary of everything up to its through_line column; it is never
-- valid for a reader who has not reached that line, however recent it is.
CREATE TABLE IF NOT EXISTS story_digests (
  id           INTEGER PRIMARY KEY,
  through_line INTEGER NOT NULL,
  summary      TEXT    NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS character_facts (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  fact            TEXT NOT NULL,
  kind            TEXT NOT NULL
                    CHECK (kind IN ('self_reference', 'speech', 'relationship', 'fact')),
  learned_at_line INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS character_facts_learned ON character_facts(learned_at_line);

-- Explanation cache. Keyed by a hash of the whole prompt -- line plus the story
-- context as the reader had it -- so a reread costs nothing, while the same line
-- met at a different point in the story is a different question and gets asked
-- again. The status column keeps failures rather than dropping them, so a broken
-- provider shows up as a pattern instead of as one-off errors in the reader.
CREATE TABLE IF NOT EXISTS explanations (
  cache_key    TEXT PRIMARY KEY,
  line_id      INTEGER REFERENCES lines(id),
  status       TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
  prompt       TEXT NOT NULL,
  result       TEXT,
  provider     TEXT,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS explanations_status ON explanations(status, created_at);

-- Phase 6. What the reader thought a line meant, written before seeing any
-- answer, and the grade that came back afterwards.
--
-- The guess is stored the moment it is submitted and never overwritten by
-- grading. An attempt is worth keeping even if the grader fails, is offline, or
-- is changed later -- it is the only record of what was actually understood at
-- that point in the story, and it cannot be reconstructed after the fact.
CREATE TABLE IF NOT EXISTS attempts (
  id         INTEGER PRIMARY KEY,
  line_id    INTEGER NOT NULL REFERENCES lines(id),
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  guess      TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  graded_at  INTEGER,
  verdict    TEXT,
  error      TEXT
);
CREATE INDEX IF NOT EXISTS attempts_line ON attempts(line_id);

-- Mining decisions. A lemma appears here once it has been approved or rejected,
-- so a word turned down does not keep resurfacing every session and a word
-- already mined is never offered twice.
CREATE TABLE IF NOT EXISTS mining (
  lemma      TEXT PRIMARY KEY,
  status     TEXT NOT NULL CHECK (status IN ('approved', 'rejected')),
  decided_at INTEGER NOT NULL,
  note_id    TEXT
);

-- Enriched cards waiting to be sent.
--
-- Kept in the database rather than held in the page because enrichment costs a
-- provider call: a reload, a closed tab or a second thought must not spend it
-- again. It also makes the batch reviewable -- the whole point of enriching
-- before creating is that you get to look at what you are about to study.
CREATE TABLE IF NOT EXISTS mining_drafts (
  lemma      TEXT PRIMARY KEY,
  front      TEXT NOT NULL,
  back       TEXT NOT NULL,
  tags       TEXT NOT NULL,
  created_at INTEGER NOT NULL
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

// ---------------------------------------------------------------------------
// Phase 3: story memory and explanation cache
// ---------------------------------------------------------------------------

export function storyDigests(): StoryDigest[] {
	return db
		.prepare('SELECT through_line AS throughLine, summary FROM story_digests')
		.all() as StoryDigest[];
}

export function characterFacts(): CharacterFact[] {
	return db
		.prepare(`SELECT name, fact, kind, learned_at_line AS learnedAt FROM character_facts`)
		.all() as CharacterFact[];
}

export function addCharacterFact(
	name: string,
	fact: string,
	kind: CharacterFact['kind'],
	learnedAtLine: number,
	at = Date.now()
): void {
	db.prepare(
		`INSERT INTO character_facts (name, fact, kind, learned_at_line, created_at)
		 VALUES (?, ?, ?, ?, ?)`
	).run(name, fact, kind, learnedAtLine, at);
}

export function addStoryDigest(throughLine: number, summary: string, at = Date.now()): void {
	db.prepare('INSERT INTO story_digests (through_line, summary, created_at) VALUES (?, ?, ?)').run(
		throughLine,
		summary,
		at
	);
}

/** Lines as the context builder wants them, for one session. */
export function contextLines(sessionId: number): ContextLine[] {
	return db
		.prepare(`SELECT seq, kind, speaker, text FROM lines WHERE session_id = ? ORDER BY seq`)
		.all(sessionId) as ContextLine[];
}

export function lineWithSeq(
	id: number
): { id: number; seq: number; session_id: number; text: string; speaker: string | null } | null {
	return (
		(db.prepare('SELECT id, seq, session_id, text, speaker FROM lines WHERE id = ?').get(id) as {
			id: number;
			seq: number;
			session_id: number;
			text: string;
			speaker: string | null;
		}) ?? null
	);
}

export function cachedExplanation(key: string): { status: string; result: string | null } | null {
	return (
		(db.prepare('SELECT status, result FROM explanations WHERE cache_key = ?').get(key) as {
			status: string;
			result: string | null;
		}) ?? null
	);
}

export function saveExplanation(
	key: string,
	lineId: number,
	prompt: string,
	result: string | null,
	provider: string,
	error: string | null,
	at = Date.now()
): void {
	db.prepare(
		`INSERT INTO explanations
		   (cache_key, line_id, status, prompt, result, provider, error, created_at, completed_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(cache_key) DO UPDATE SET
		   status = excluded.status, result = excluded.result,
		   error = excluded.error, completed_at = excluded.completed_at`
	).run(key, lineId, error ? 'failed' : 'done', prompt, result, provider, error, at, at);
}

// ---------------------------------------------------------------------------
// Phase 6: attempts
// ---------------------------------------------------------------------------

export type AttemptRow = {
	id: number;
	line_id: number;
	guess: string;
	created_at: number;
	graded_at: number | null;
	verdict: string | null;
	error: string | null;
};

/** Stored before grading is attempted, so a grader failure never loses it. */
export function saveAttempt(
	lineId: number,
	sessionId: number,
	guess: string,
	at = Date.now()
): number {
	const r = db
		.prepare('INSERT INTO attempts (line_id, session_id, guess, created_at) VALUES (?, ?, ?, ?)')
		.run(lineId, sessionId, guess, at);
	return Number(r.lastInsertRowid);
}

export function recordVerdict(
	id: number,
	verdict: string | null,
	error: string | null,
	at = Date.now()
): void {
	db.prepare('UPDATE attempts SET verdict = ?, error = ?, graded_at = ? WHERE id = ?').run(
		verdict,
		error,
		at,
		id
	);
}

export function attemptsForLine(lineId: number): AttemptRow[] {
	return db
		.prepare('SELECT * FROM attempts WHERE line_id = ? ORDER BY id')
		.all(lineId) as AttemptRow[];
}

export function attemptById(id: number): AttemptRow | null {
	return (db.prepare('SELECT * FROM attempts WHERE id = ?').get(id) as AttemptRow) ?? null;
}

export type DraftRow = {
	lemma: string;
	front: string;
	back: string;
	tags: string;
	created_at: number;
};

export function saveDraft(
	draft: { lemma: string; front: string; back: string; tags: string },
	at = Date.now()
): void {
	db.prepare(
		`INSERT INTO mining_drafts (lemma, front, back, tags, created_at) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(lemma) DO UPDATE SET front = excluded.front,
		                                  back = excluded.back,
		                                  tags = excluded.tags,
		                                  created_at = excluded.created_at`
	).run(draft.lemma, draft.front, draft.back, draft.tags, at);
}

export function listDrafts(): DraftRow[] {
	return db
		.prepare('SELECT * FROM mining_drafts ORDER BY created_at ASC, lemma ASC')
		.all() as DraftRow[];
}

export function draftByLemma(lemma: string): DraftRow | null {
	return (db.prepare('SELECT * FROM mining_drafts WHERE lemma = ?').get(lemma) as DraftRow) ?? null;
}

export function deleteDraft(lemma: string): void {
	db.prepare('DELETE FROM mining_drafts WHERE lemma = ?').run(lemma);
}
