import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

/**
 * JMdict lookup.
 *
 * Read-only and opened lazily, so a missing database degrades to "no
 * definitions" rather than taking the whole reader down. Being unable to look a
 * word up is a bad evening; being unable to read at all is a broken tool.
 */

export type Sense = {
	pos: string[];
	misc: string[];
	info: string[];
	gloss: string[];
};

export type Entry = {
	id: string;
	kanji: string[];
	kana: string[];
	senses: Sense[];
	/** Whether the form that matched is marked common in JMdict. */
	common: boolean;
};

const DB_PATH = process.env.YOMU_JMDICT ?? 'data/jmdict.db';

let db: Database.Database | null = null;
let checked = false;

function open(): Database.Database | null {
	if (checked) return db;
	checked = true;
	if (!existsSync(DB_PATH)) return null;
	db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
	return db;
}

export function dictionaryAvailable(): boolean {
	return open() !== null;
}

/**
 * Entries whose written or read form matches exactly.
 *
 * Common forms first: an uncommon homograph outranking the everyday word is
 * worse than no ordering at all, because the reader will believe the first
 * result.
 */
export function lookupForm(form: string, limit = 8): Entry[] {
	const conn = open();
	if (!conn || !form) return [];

	const rows = conn
		.prepare(
			`SELECT e.id AS id, e.data AS data, MAX(f.common) AS common
			 FROM forms f
			 JOIN entries e ON e.id = f.entry_id
			 WHERE f.form = ?
			 GROUP BY e.id
			 ORDER BY common DESC
			 LIMIT ?`
		)
		.all(form, limit) as { id: string; data: string; common: number }[];

	return rows.map((r) => ({ id: r.id, common: r.common === 1, ...JSON.parse(r.data) }));
}

/**
 * Look a token up, trying the most specific key first.
 *
 * kuromoji supplies `basic_form`, which is already the dictionary form, so
 * conjugation is mostly handled before this point -- 見開かれて arrives as
 * 見開く. The surface is tried next for words kuromoji could not analyse, and
 * the reading last, which catches entries written in kana in the dictionary but
 * in kanji in the text.
 */
export function lookup(lemma: string, surface?: string, reading?: string): Entry[] {
	for (const key of [lemma, surface, reading]) {
		if (!key) continue;
		const hits = lookupForm(key);
		if (hits.length > 0) return hits;
	}
	return [];
}
