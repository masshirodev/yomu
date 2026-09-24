import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SESSION_IDLE_MS, type AdvanceSample, type LookupSample } from '$lib/stats';
import type { LookupRecord } from 'kotoba';
import type { CharacterFact, ContextLine, StoryDigest } from '$lib/context';

const DB_PATH = process.env.YOMU_DB ?? 'data/yomu.db';

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
-- A work is one visual novel. Everything the reader knows is scoped to one:
-- the story context, the character names, the mined vocabulary. Without this,
-- reading a second VN would explain its lines using the first one's plot and
-- offer the first one's cast as name readings -- quietly wrong answers rather
-- than a visible error, which is the worse kind.
CREATE TABLE IF NOT EXISTS works (
  id         INTEGER PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  -- Which engine's markup its lines carry. Per work because the markup belongs
  -- to the engine: manosaba emits clean text, Steins;Gate carries pause codes,
  -- colour spans and ruby.
  dialect    TEXT NOT NULL DEFAULT 'none',
  created_at INTEGER NOT NULL
);

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

/**
 * Which card format a note was written in.
 *
 * Bumped when the composer starts producing something the old cards do not
 * have, so "which cards are out of date" is a fact the server knows rather than
 * something the page remembers. Without it a reload made every card look
 * un-rebuilt, and a rebuild attempted while the provider was down would
 * overwrite an enriched card with a dictionary-only one.
 *
 * 1: readings, romaji, annotated sentence, and meaning in context.
 * 2: the front is the dictionary form rather than the inflected surface, and
 *    recorded name readings override the tokenizer in the sentence. Format 1
 *    shipped 桜[さくら]羽[わ]エマ, which teaches a reading that is simply wrong.
 * 3: the model's answers are matched back by lemma, then surface, then
 *    position. Format 2 keyed on the lemma alone, so every word whose lemma
 *    differed from the form it appeared as -- 待つ, 気安い, 吐く -- silently
 *    lost its enrichment and shipped a thin card.
 * 4: a literal gloss beside the natural translation, so the sentence shows how
 *    its parts add up rather than only what they add up to.
 * 5: a rebuild no longer replaces a card when the enrichment for it is missing.
 *    A provider timeout under format 4 rewrote every card from the dictionary
 *    alone -- losing all eleven translations and notes -- and then stamped them
 *    current, so nothing would have offered them again. Also: no romaji line
 *    when the romaji still contains kanji, and names take their reading from
 *    the name thread when the dictionary has none.
 */
export const CARD_FORMAT = 5;

// Rows written before the column existed default to 0, which is exactly right:
// they predate every format and all of them need rebuilding.
const miningColumns = db.prepare('PRAGMA table_info(mining)').all() as { name: string }[];
if (!miningColumns.some((c) => c.name === 'card_format')) {
	db.exec('ALTER TABLE mining ADD COLUMN card_format INTEGER NOT NULL DEFAULT 0');
}

/* ------------------------------------------------------------------ works -- */

/**
 * The work every pre-existing row belongs to.
 *
 * Configurable because the slug ends up on flashcard tags, but it only names
 * data that was recorded before works existed -- there was exactly one VN then,
 * so there is exactly one right answer.
 */
const DEFAULT_WORK_SLUG = process.env.YOMU_DEFAULT_WORK ?? 'manosaba';
const DEFAULT_WORK_TITLE = process.env.YOMU_DEFAULT_WORK_TITLE ?? '魔法少女ノ魔女裁判';

/**
 * A work id, branded so it cannot be confused with the other numbers here.
 *
 * Not ceremony. Scoping these reads by work turned `contextLines(sessionId)`
 * into a call that still compiled and silently read the wrong story, and
 * `currentSession(timestamp)` into one that passed a clock reading as an id.
 * Both typechecked cleanly. A brand is what makes the compiler notice.
 */
export type WorkId = number & { readonly __brand: 'WorkId' };

export function ensureWork(slug: string, title?: string, dialect?: string): WorkId {
	const clean = slug
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/gu, '-')
		.replace(/^-|-$/gu, '');
	if (!clean) throw new Error('a work needs a slug');

	const found = db.prepare('SELECT id FROM works WHERE slug = ?').get(clean) as
		{ id: number } | undefined;
	if (found) {
		// A dialect may be declared later, but never silently cleared.
		if (dialect) db.prepare('UPDATE works SET dialect = ? WHERE id = ?').run(dialect, found.id);
		return found.id as WorkId;
	}

	const r = db
		.prepare('INSERT INTO works (slug, title, dialect, created_at) VALUES (?, ?, ?, ?)')
		.run(clean, title?.trim() || clean, dialect || 'none', Date.now());
	return Number(r.lastInsertRowid) as WorkId;
}

const hasColumn = (table: string, column: string) =>
	(db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
		(c) => c.name === column
	);

/**
 * Attach every table that holds per-story knowledge to a work.
 *
 * Runs once. The guard is the column's own absence, so a restart is a no-op and
 * a half-applied migration finishes itself.
 */
// Works created before dialects existed carry clean text, which is 'none'.
if (!hasColumn('works', 'dialect')) {
	db.exec("ALTER TABLE works ADD COLUMN dialect TEXT NOT NULL DEFAULT 'none'");
}

if (!hasColumn('sessions', 'work_id')) {
	const migrate = db.transaction(() => {
		db.exec('ALTER TABLE sessions ADD COLUMN work_id INTEGER REFERENCES works(id)');
		const workId = ensureWork(DEFAULT_WORK_SLUG, DEFAULT_WORK_TITLE);
		db.prepare('UPDATE sessions SET work_id = ? WHERE work_id IS NULL').run(workId);

		// seq was allocated per session, so it restarted at 0 every time a session
		// rolled over -- and seq is what the spoiler boundary compares against.
		// A fact learned at line 900 was being filtered against a line numbered 3.
		// Renumbering by insertion order makes it monotonic per work, which is what
		// "everything the reader has read of this story" actually means.
		db.exec(`UPDATE lines SET seq = (SELECT COUNT(*) FROM lines older WHERE older.id < lines.id)`);
	});
	migrate();
}

for (const [table, extra] of [
	['story_digests', ''],
	['character_facts', '']
] as const) {
	void extra;
	if (!hasColumn(table, 'work_id')) {
		db.exec(`ALTER TABLE ${table} ADD COLUMN work_id INTEGER REFERENCES works(id)`);
		db.prepare(`UPDATE ${table} SET work_id = ? WHERE work_id IS NULL`).run(
			ensureWork(DEFAULT_WORK_SLUG, DEFAULT_WORK_TITLE)
		);
	}
}

/**
 * Rebuild the tables whose primary key has to change.
 *
 * `names`, `mining` and `mining_drafts` were keyed by the surface or lemma
 * alone, which silently assumed one story: the same word met in two VNs would
 * collide, and mining one would mark it decided in the other. SQLite cannot
 * alter a primary key, so each is rebuilt and copied.
 */
for (const [table, create, columns] of [
	[
		'names',
		`CREATE TABLE names_v2 (
		   work_id    INTEGER NOT NULL REFERENCES works(id),
		   surface    TEXT NOT NULL,
		   reading    TEXT,
		   seen_count INTEGER NOT NULL DEFAULT 0,
		   first_seen INTEGER NOT NULL,
		   PRIMARY KEY (work_id, surface)
		 )`,
		'surface, reading, seen_count, first_seen'
	],
	[
		'mining',
		`CREATE TABLE mining_v2 (
		   work_id     INTEGER NOT NULL REFERENCES works(id),
		   lemma       TEXT NOT NULL,
		   status      TEXT NOT NULL CHECK (status IN ('approved', 'rejected')),
		   decided_at  INTEGER NOT NULL,
		   note_id     TEXT,
		   card_format INTEGER NOT NULL DEFAULT 0,
		   PRIMARY KEY (work_id, lemma)
		 )`,
		'lemma, status, decided_at, note_id, card_format'
	],
	[
		'mining_drafts',
		`CREATE TABLE mining_drafts_v2 (
		   work_id    INTEGER NOT NULL REFERENCES works(id),
		   lemma      TEXT NOT NULL,
		   front      TEXT NOT NULL,
		   back       TEXT NOT NULL,
		   tags       TEXT NOT NULL,
		   created_at INTEGER NOT NULL,
		   PRIMARY KEY (work_id, lemma)
		 )`,
		'lemma, front, back, tags, created_at'
	]
] as const) {
	if (hasColumn(table, 'work_id')) continue;
	const workId = ensureWork(DEFAULT_WORK_SLUG, DEFAULT_WORK_TITLE);
	const rebuild = db.transaction(() => {
		db.exec(create);
		db.exec(
			`INSERT INTO ${table}_v2 (work_id, ${columns})
			 SELECT ${workId}, ${columns} FROM ${table}`
		);
		db.exec(`DROP TABLE ${table}`);
		db.exec(`ALTER TABLE ${table}_v2 RENAME TO ${table}`);
	});
	rebuild();
}

export type WorkRow = {
	id: WorkId;
	slug: string;
	title: string;
	dialect: string;
	created_at: number;
	lines: number;
	last_at: number | null;
};

export function listWorks(): WorkRow[] {
	return db
		.prepare(
			`SELECT w.id, w.slug, w.title, w.dialect, w.created_at,
			        COUNT(l.id) AS lines, MAX(l.received_at) AS last_at
			 FROM works w
			 LEFT JOIN sessions s ON s.work_id = w.id
			 LEFT JOIN lines l ON l.session_id = s.id
			 GROUP BY w.id
			 ORDER BY last_at IS NULL, last_at DESC, w.id`
		)
		.all() as WorkRow[];
}

/** The work the reader is on: whichever was read most recently. */
export function currentWork(): WorkRow {
	const [first] = listWorks();
	if (first) return first;
	ensureWork(DEFAULT_WORK_SLUG, DEFAULT_WORK_TITLE);
	return listWorks()[0];
}

export function workBySlug(slug: string): WorkRow | null {
	return listWorks().find((w) => w.slug === slug) ?? null;
}

export function openSession(workId: WorkId, now = Date.now()): number {
	const r = db.prepare('INSERT INTO sessions (started_at, work_id) VALUES (?, ?)').run(now, workId);
	return Number(r.lastInsertRowid);
}

/**
 * The open session, rolling over to a new one after a long enough gap.
 *
 * Without this a session never ends, so "this session" eventually spans weeks
 * and every derived statistic becomes an average over unrelated evenings.
 */
/**
 * The open session for a work, rolling it over after a gap.
 *
 * Per work, because two stories read in the same evening are two sittings, not
 * one: sharing a session would put one VN's pace and lookups into the other's
 * statistics.
 */
export function currentSession(workId?: WorkId, now = Date.now()): number {
	const work = workId ?? currentWork().id;

	const row = db
		.prepare(
			`SELECT s.id AS id,
			        COALESCE(MAX(l.received_at), s.started_at) AS last_at
			 FROM sessions s
			 LEFT JOIN lines l ON l.session_id = s.id
			 WHERE s.ended_at IS NULL AND s.work_id = ?
			 GROUP BY s.id
			 ORDER BY s.id DESC
			 LIMIT 1`
		)
		.get(work) as { id: number; last_at: number } | undefined;

	if (!row) return openSession(work, now);

	if (now - row.last_at > SESSION_IDLE_MS) {
		db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(row.last_at, row.id);
		return openSession(work, now);
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
export function allLookups(workId: WorkId): LookupRecord[] {
	const rows = db
		.prepare(
			`SELECT e.payload AS payload, e.at AS at, e.session_id AS sessionId, e.line_id AS lineId
			 FROM events e
			 JOIN sessions s ON s.id = e.session_id
			 WHERE s.work_id = ?
			   AND e.type = 'lookup'
			   AND e.payload IS NOT NULL
			   AND json_extract(e.payload, '$.lemma')
			         NOT IN (SELECT lemma FROM mining WHERE work_id = ?)`
		)
		.all(workId, workId) as {
		payload: string;
		at: number;
		sessionId: number;
		lineId: number | null;
	}[];

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
	workId: WorkId,
	lemma: string,
	status: 'approved' | 'rejected',
	noteId: string | null,
	at = Date.now(),
	cardFormat = CARD_FORMAT
): void {
	db.prepare(
		`INSERT INTO mining (work_id, lemma, status, decided_at, note_id, card_format)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(work_id, lemma) DO UPDATE SET status = excluded.status,
		                                  decided_at = excluded.decided_at,
		                                  note_id = excluded.note_id,
		                                  card_format = excluded.card_format`
	).run(workId, lemma, status, at, noteId, cardFormat);
}

/** Mark a note as rewritten in the current format. */
export function markCardFormat(workId: WorkId, lemma: string, cardFormat = CARD_FORMAT): void {
	db.prepare('UPDATE mining SET card_format = ? WHERE work_id = ? AND lemma = ?').run(
		cardFormat,
		workId,
		lemma
	);
}

export function miningCounts(workId: WorkId): { approved: number; rejected: number } {
	const rows = db
		.prepare('SELECT status, COUNT(*) AS n FROM mining WHERE work_id = ? GROUP BY status')
		.all(workId) as {
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

// Per work, not per session. seq is what the spoiler boundary compares against,
// so it has to mean "how far into this story" -- restarting it at every session
// rollover made a fact learned at line 900 filter against a line numbered 3.
const nextSeq = db.prepare(
	`SELECT COALESCE(MAX(l.seq), -1) + 1 AS n
	 FROM lines l JOIN sessions s ON s.id = l.session_id
	 WHERE s.work_id = (SELECT work_id FROM sessions WHERE id = ?)`
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
	`INSERT INTO names (work_id, surface, reading, seen_count, first_seen)
	 VALUES (?, ?, NULL, 1, ?)
	 ON CONFLICT(work_id, surface) DO UPDATE SET seen_count = seen_count + 1`
);

/** Record a speaker sighting. The reading is left for a human to supply. */
export function noteName(workId: WorkId, surface: string, at: number): void {
	if (surface) upsertName.run(workId, surface, at);
}

export type NameRow = { surface: string; reading: string | null; seen_count: number };

export function listNames(workId: WorkId): NameRow[] {
	return db
		.prepare(
			`SELECT surface, reading, seen_count FROM names
			 WHERE work_id = ? ORDER BY seen_count DESC, surface`
		)
		.all(workId) as NameRow[];
}

export function setNameReading(workId: WorkId, surface: string, reading: string | null): void {
	db.prepare('UPDATE names SET reading = ? WHERE work_id = ? AND surface = ?').run(
		reading || null,
		workId,
		surface
	);
}

/**
 * The tail of a work, across sessions.
 *
 * Deliberately not scoped to the current session. It was, and so opening the
 * reader after a break showed nothing at all: a session rolls over after thirty
 * minutes idle, and the first thing a fresh session has is no lines. Coming
 * back to a story should show where you left off.
 */
export function recentLines(workId: WorkId, limit = 200): StoredLine[] {
	return db
		.prepare(
			`SELECT l.id, l.seq, l.kind, l.speaker, l.text, l.received_at
			 FROM lines l JOIN sessions s ON s.id = l.session_id
			 WHERE s.work_id = ? ORDER BY l.seq DESC LIMIT ?`
		)
		.all(workId, limit)
		.reverse() as StoredLine[];
}

// ---------------------------------------------------------------------------
// Phase 3: story memory and explanation cache
// ---------------------------------------------------------------------------

export function storyDigests(workId: WorkId): StoryDigest[] {
	return db
		.prepare('SELECT through_line AS throughLine, summary FROM story_digests WHERE work_id = ?')
		.all(workId) as StoryDigest[];
}

export function characterFacts(workId: WorkId): CharacterFact[] {
	return db
		.prepare(
			`SELECT name, fact, kind, learned_at_line AS learnedAt
			 FROM character_facts WHERE work_id = ?`
		)
		.all(workId) as CharacterFact[];
}

export function addCharacterFact(
	workId: WorkId,
	name: string,
	fact: string,
	kind: CharacterFact['kind'],
	learnedAtLine: number,
	at = Date.now()
): void {
	db.prepare(
		`INSERT INTO character_facts (work_id, name, fact, kind, learned_at_line, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`
	).run(workId, name, fact, kind, learnedAtLine, at);
}

export function addStoryDigest(
	workId: WorkId,
	throughLine: number,
	summary: string,
	at = Date.now()
): void {
	db.prepare(
		'INSERT INTO story_digests (work_id, through_line, summary, created_at) VALUES (?, ?, ?, ?)'
	).run(workId, throughLine, summary, at);
}

/** Lines as the context builder wants them, for one session. */
/** Everything read of a work, for the context window to filter by read position. */
export function contextLines(workId: WorkId): ContextLine[] {
	return db
		.prepare(
			`SELECT l.seq, l.kind, l.speaker, l.text
			 FROM lines l JOIN sessions s ON s.id = l.session_id
			 WHERE s.work_id = ? ORDER BY l.seq`
		)
		.all(workId) as ContextLine[];
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
	workId: WorkId,
	draft: { lemma: string; front: string; back: string; tags: string },
	at = Date.now()
): void {
	db.prepare(
		`INSERT INTO mining_drafts (work_id, lemma, front, back, tags, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(work_id, lemma) DO UPDATE SET front = excluded.front,
		                                  back = excluded.back,
		                                  tags = excluded.tags,
		                                  created_at = excluded.created_at`
	).run(workId, draft.lemma, draft.front, draft.back, draft.tags, at);
}

export function listDrafts(workId: WorkId): DraftRow[] {
	return db
		.prepare('SELECT * FROM mining_drafts WHERE work_id = ? ORDER BY created_at ASC, lemma ASC')
		.all(workId) as DraftRow[];
}

export function draftByLemma(workId: WorkId, lemma: string): DraftRow | null {
	return (
		(db
			.prepare('SELECT * FROM mining_drafts WHERE work_id = ? AND lemma = ?')
			.get(workId, lemma) as DraftRow) ?? null
	);
}

export function deleteDraft(workId: WorkId, lemma: string): void {
	db.prepare('DELETE FROM mining_drafts WHERE work_id = ? AND lemma = ?').run(workId, lemma);
}

export type MinedWord = {
	lemma: string;
	noteId: string;
	surface: string;
	lineId: number | null;
};

/**
 * Words whose Lattice card is older than the current format.
 *
 * `allLookups` deliberately hides these -- a mined word is not a candidate any
 * more -- so rebuilding needs its own read. The surface and line come from the
 * most recent lookup, the same ones the card was built from originally.
 *
 * Filtering on the format is what stops a rebuild from running twice: an
 * already-current card is not offered, so a second pass while the provider is
 * down cannot replace an enriched card with a dictionary-only one.
 */
export function minedWords(workId: WorkId): MinedWord[] {
	const rows = db
		.prepare(
			// MAX(e.at) with bare columns is SQLite's documented way of picking the
			// whole row that carries the maximum -- the most recent lookup, which is
			// the one the card was built from.
			`SELECT m.lemma AS lemma, m.note_id AS noteId, e.payload AS payload,
			        e.line_id AS lineId, MAX(e.at) AS at
			 FROM mining m
			 JOIN events e ON e.type = 'lookup'
			               AND json_extract(e.payload, '$.lemma') = m.lemma
			 WHERE m.work_id = ? AND m.status = 'approved' AND m.note_id IS NOT NULL
			   AND m.card_format < ?
			 GROUP BY m.lemma
			 ORDER BY m.decided_at ASC`
		)
		.all(workId, CARD_FORMAT) as {
		lemma: string;
		noteId: string;
		payload: string;
		lineId: number | null;
	}[];

	return rows.map((r) => {
		let surface = r.lemma;
		try {
			const p = JSON.parse(r.payload);
			if (typeof p.surface === 'string' && p.surface) surface = p.surface;
		} catch {
			// Keep the lemma. A malformed payload must not drop the card.
		}
		return { lemma: r.lemma, noteId: r.noteId, surface, lineId: r.lineId };
	});
}

/**
 * The most recently stored line, whatever session it belonged to.
 *
 * Deliberately not scoped to a session. It exists to seed the parser's
 * echo suppression, and the case that needs it most is the game redrawing the
 * line you stopped on when you come back -- which by definition lands in a new
 * session, where per-session carry-over is empty.
 */
export function lastStoredLine(): { text: string; received_at: number } | null {
	return (
		(db.prepare('SELECT text, received_at FROM lines ORDER BY id DESC LIMIT 1').get() as {
			text: string;
			received_at: number;
		}) ?? null
	);
}

/** Which work a session belongs to, for the routes that start from a line. */
export function workForSession(sessionId: number): WorkId {
	const row = db.prepare('SELECT work_id FROM sessions WHERE id = ?').get(sessionId) as
		{ work_id: number } | undefined;
	return (row?.work_id ?? currentWork().id) as WorkId;
}

/**
 * A reading the game itself supplied, via its own ruby.
 *
 * Stored in the same table as character names because it does the same job:
 * an authoritative surface-to-reading pair that overrides the tokenizer. It is
 * the strongest source there is -- 運命石の扉 reads シュタインズゲート, which no
 * dictionary and no morphological analyser will ever produce -- so unlike a
 * name discovered from the speaker thread, this arrives already answered and
 * never needs a human to fill it in.
 */
export function noteGameReading(workId: WorkId, surface: string, reading: string): void {
	if (!surface || !reading) return;
	db.prepare(
		`INSERT INTO names (work_id, surface, reading, seen_count, first_seen)
		 VALUES (?, ?, ?, 1, ?)
		 ON CONFLICT(work_id, surface) DO UPDATE SET
		   seen_count = seen_count + 1,
		   -- Only fills a gap. A reading corrected by hand outranks the engine's,
		   -- which has been seen to mis-split a run.
		   reading = COALESCE(names.reading, excluded.reading)`
	).run(workId, surface, reading, Date.now());
}
