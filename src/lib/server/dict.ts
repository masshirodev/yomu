import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setJmdictPath } from 'kotoba/server';

/**
 * JMdict lookup: kotoba's, shared with tsundoku (../kotoba, README.md).
 *
 * Read-only and opened lazily, so a missing database degrades to "no
 * definitions" rather than taking the whole reader down. Being unable to look a
 * word up is a bad evening; being unable to read at all is a broken tool.
 *
 * Which database: `YOMU_JMDICT` (the Docker image bakes one in), else
 * `KOTOBA_JMDICT`, else the copy both apps read on the workstation, else the
 * old `data/jmdict.db`.
 */
const shared = join(homedir(), '.local/share/kotoba/jmdict.db');
setJmdictPath(
	process.env.YOMU_JMDICT ??
		process.env.KOTOBA_JMDICT ??
		(existsSync(shared) ? shared : 'data/jmdict.db')
);

export { dictionaryAvailable, lookup, lookupForm, type Entry, type Sense } from 'kotoba/server';
