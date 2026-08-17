/**
 * Build the JMdict lookup database.
 *
 * Downloads a jmdict-simplified release and flattens it into SQLite: one row
 * per entry, plus an indexed row per written form so a lookup is a single
 * indexed SELECT.
 *
 * ## Why this one runs on the server
 *
 * Tokenisation deliberately runs in the browser -- it is per-line and CPU-bound,
 * and the VPS has no cores to spare. Dictionary lookup is the opposite: once per
 * click, and an indexed key lookup rather than computation. Shipping 60MB of
 * JSON to the client every session to avoid roughly a hundred microsecond
 * queries would be the wrong trade in both directions.
 *
 *   node scripts/build-dict.js [--out data/jmdict.db]
 */
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const RELEASES = 'https://api.github.com/repos/scriptin/jmdict-simplified/releases/latest';

const outArg = process.argv.indexOf('--out');
const OUT = outArg === -1 ? 'data/jmdict.db' : process.argv[outArg + 1];

async function fetchRelease() {
	const res = await fetch(RELEASES, { headers: { 'user-agent': 'yomu-build' } });
	if (!res.ok) throw new Error(`release lookup failed: ${res.status}`);
	const release = await res.json();

	// The full English edition, not the "common" subset. This VN leans literary --
	// 蔑む, 貶める, 嘲笑 are exactly the words that send you to a dictionary, and
	// exactly the ones a common-only build omits.
	const asset = release.assets.find(
		(a) => /^jmdict-eng-\d/.test(a.name) && a.name.endsWith('.json.tgz')
	);
	if (!asset) throw new Error('no jmdict-eng .json.tgz in latest release');
	return { url: asset.browser_download_url, name: asset.name, version: release.tag_name };
}

async function download(url, dest) {
	const res = await fetch(url, { redirect: 'follow' });
	if (!res.ok) throw new Error(`download failed: ${res.status}`);
	writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function build(words, version) {
	mkdirSync(dirname(OUT), { recursive: true });
	rmSync(OUT, { force: true });

	const db = new Database(OUT);
	db.pragma('journal_mode = OFF');
	db.pragma('synchronous = OFF');

	db.exec(`
		CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
		CREATE TABLE entries (id TEXT PRIMARY KEY, data TEXT NOT NULL);
		CREATE TABLE forms (
			form     TEXT NOT NULL,
			entry_id TEXT NOT NULL REFERENCES entries(id),
			-- JMdict's own frequency marking. Without it, looking up a common word
			-- surfaces obscure homographs first, which is worse than no ordering.
			common   INTEGER NOT NULL DEFAULT 0
		);
	`);

	const putMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
	const putEntry = db.prepare('INSERT INTO entries (id, data) VALUES (?, ?)');
	const putForm = db.prepare('INSERT INTO forms (form, entry_id, common) VALUES (?, ?, ?)');

	let forms = 0;
	const write = db.transaction(() => {
		putMeta.run('version', version);
		putMeta.run('built_at', new Date().toISOString());

		for (const w of words) {
			const senses = w.sense.map((s) => ({
				pos: s.partOfSpeech ?? [],
				misc: s.misc ?? [],
				info: s.info ?? [],
				gloss: (s.gloss ?? []).map((g) => g.text)
			}));

			putEntry.run(
				w.id,
				JSON.stringify({
					kanji: (w.kanji ?? []).map((k) => k.text),
					kana: (w.kana ?? []).map((k) => k.text),
					senses
				})
			);

			// Index every written and read form. A token's surface may match either,
			// and kuromoji reports readings for words written in kana too.
			const seen = new Set();
			for (const k of [...(w.kanji ?? []), ...(w.kana ?? [])]) {
				if (seen.has(k.text)) continue;
				seen.add(k.text);
				putForm.run(k.text, w.id, k.common ? 1 : 0);
				forms++;
			}
		}
	});
	write();

	// Built after insert: maintaining the index during a few hundred thousand
	// inserts is markedly slower than creating it once at the end.
	db.exec('CREATE INDEX forms_form ON forms(form, common DESC)');
	db.exec('VACUUM');
	db.close();

	return forms;
}

const { url, name, version } = await fetchRelease();
console.log(`jmdict-simplified ${version}\n  ${name}`);

const tgz = join(tmpdir(), name);
const dir = join(tmpdir(), 'yomu-jmdict');
mkdirSync(dir, { recursive: true });

await download(url, tgz);
execFileSync('tar', ['-xzf', tgz, '-C', dir]);

const jsonName = execFileSync('sh', ['-c', `ls ${dir}/*.json | head -1`])
	.toString()
	.trim();
const words = JSON.parse(readFileSync(jsonName, 'utf8')).words;
console.log(`  ${words.length} entries`);

const forms = build(words, version);
console.log(`built ${OUT}: ${words.length} entries, ${forms} forms`);

rmSync(tgz, { force: true });
rmSync(dir, { recursive: true, force: true });
