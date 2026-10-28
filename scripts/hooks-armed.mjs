#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * That the husky hooks in `.husky/` are actually installed for this checkout.
 *
 * `.husky/_` is the directory git is pointed at by `core.hooksPath`, and it is
 * **gitignored**. `git worktree add` therefore never creates it, and git's
 * behaviour when `core.hooksPath` names a directory that does not exist is to
 * run nothing and say nothing: every commit and every push succeeds, silently,
 * with no check having run.
 *
 * In Kumiko, waves 18-20 of its parallel-agent batches ran fifteen agent-slots that
 * way. Each of them reported that the hooks had passed. None of them had a hook
 * installed, and there was no way to tell from inside the worktree -- which is
 * the whole reason this file exists as a check rather than as a line in a
 * setup procedure. The remedy was "the coordinator remembers to run
 * `npx husky`", and fifteen slots is a large enough sample to say that a
 * procedure nobody can verify is not a control.
 *
 * ### Where this has to run, and why it cannot run in a hook
 *
 * The thing being detected is the absence of the mechanism that runs hooks, so
 * a hook is the one place the check is guaranteed not to fire. It is wired into
 * `yarn run check` instead -- the command `AGENTS.md` names as the one to run
 * before committing, and the command `pre-push` runs first -- so the failure
 * arrives on the path an agent takes anyway.
 *
 * It is *also* a step in `pre-push`, which is not redundant: `.husky/_` can
 * exist while being empty or partial (an interrupted `npx husky`, a hand-copied
 * directory, a husky major bump that renamed its bootstrap). In that state
 * `pre-push` runs while `pre-commit` does not, and only a check that compares
 * the two directories can see it. Testing this by deleting `.husky/_` outright
 * does not cover that case.
 *
 * ### What it does not do
 *
 * It does not verify that the installed hook still forwards to the file in
 * `.husky/`; husky's shims are three lines and are not a thing that rots. It
 * asks the narrow question a worktree gets wrong: for every hook this
 * repository declares, is there an executable of that name where git is
 * looking?
 *
 * ### When it stays quiet
 *
 * Outside a git work tree there are no hooks to arm and nothing to say. That is
 * the image build (`git archive` and the Dockerfile's `COPY`, neither of which
 * carries `.git`), and a deploy tarball. Both are checked for explicitly rather
 * than inferred from an error, because "git failed for some reason" and "this
 * is not a repository" want different answers.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/** Where husky puts its shims, relative to the work tree root. */
const HUSKY_DIR = '.husky';
const INSTALL_DIR = '_';

/**
 * @typedef {object} HooksReport
 * @property {'armed' | 'unarmed' | 'partial' | 'uninstalled' | 'not-a-repo'} state
 * @property {string[]} declared  Hook names `.husky/` defines, sorted.
 * @property {string[]} missing   Declared hooks with no executable where git looks.
 * @property {string | null} hooksPath  `core.hooksPath` as configured, or null.
 * @property {string | null} resolved   Absolute directory git will look in, or null.
 * @property {string} detail      One line naming what is wrong, empty when armed.
 */

/**
 * Run a git command against a work tree, returning null rather than throwing
 * when git is absent or the directory is not a repository.
 *
 * @param {string} root
 * @param {string[]} args
 * @returns {string | null}
 */
function git(root, args) {
	const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
	if (result.error || result.status !== 0) return null;
	return result.stdout.trim();
}

/**
 * The hooks `.husky/` declares: regular files at its top level, excluding the
 * install directory and anything dotted. Deliberately not a hard-coded list of
 * the three that exist today -- a fourth hook added without this noticing would
 * be a hook that is never checked for, which is the same defect one level up.
 *
 * @param {string} huskyDir
 * @returns {string[]}
 */
function declaredHooks(huskyDir) {
	if (!existsSync(huskyDir)) return [];
	return readdirSync(huskyDir)
		.filter((name) => !name.startsWith('.') && name !== INSTALL_DIR)
		.filter((name) => {
			try {
				return statSync(join(huskyDir, name)).isFile();
			} catch {
				return false;
			}
		})
		.sort();
}

/**
 * @param {string} file
 * @returns {boolean}
 */
function isExecutableFile(file) {
	try {
		const stat = statSync(file);
		// Any execute bit. Checking the owner's alone would misreport a tree
		// restored from an archive that widened the mode.
		return stat.isFile() && (stat.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

/**
 * @param {object} [options]
 * @param {string} [options.root] Work tree to audit. Defaults to this repository.
 * @param {string | null} [options.hooksPath] Override `core.hooksPath` instead of asking git.
 * @param {boolean} [options.isRepo] Override the work-tree probe.
 * @returns {HooksReport}
 */
export function auditHooks(options = {}) {
	const root = options.root ?? ROOT;
	const huskyDir = join(root, HUSKY_DIR);
	const declared = declaredHooks(huskyDir);

	const isRepo =
		options.isRepo ??
		(options.hooksPath !== undefined ||
			git(root, ['rev-parse', '--is-inside-work-tree']) === 'true');

	if (!isRepo)
		return {
			state: 'not-a-repo',
			declared,
			missing: [],
			hooksPath: null,
			resolved: null,
			detail: ''
		};

	const hooksPath =
		options.hooksPath !== undefined
			? options.hooksPath
			: git(root, ['config', '--get', 'core.hooksPath']);

	if (!hooksPath)
		return {
			state: 'uninstalled',
			declared,
			missing: declared,
			hooksPath: null,
			resolved: null,
			detail:
				'git core.hooksPath is not set, so git is using .git/hooks and nothing in .husky/ runs'
		};

	// Git resolves a relative core.hooksPath against the top level of the work
	// tree it is running in, which in a worktree is that worktree rather than the
	// main checkout. Resolving it here the same way is the point: a value that
	// only resolves in the main checkout is exactly the bug.
	const resolved = isAbsolute(hooksPath) ? hooksPath : resolve(root, hooksPath);
	const missing = declared.filter((name) => !isExecutableFile(join(resolved, name)));

	if (missing.length === 0)
		return { state: 'armed', declared, missing, hooksPath, resolved, detail: '' };

	const state = missing.length === declared.length ? 'unarmed' : 'partial';
	const detail = existsSync(resolved)
		? `${resolved} exists but has no executable for ${missing.join(', ')}`
		: `${resolved} does not exist, so every hook in .husky/ silently does nothing`;

	return { state, declared, missing, hooksPath, resolved, detail };
}

if (import.meta.url === `file://${resolve(process.argv[1] ?? '')}`) {
	// No colour, like every other script under scripts/: the hooks add their own
	// and a script that adds a second layer prints escapes into a CI log.
	if (process.env.SKIP_ALL || process.env.SKIP_HOOKS) {
		console.log('[skip] hook arming check');
		process.exit(0);
	}

	const report = auditHooks();

	if (report.state === 'not-a-repo') {
		// Nothing to say, and nothing wrong: the image build and the deploy
		// tarball both get here.
		process.exit(0);
	}

	if (report.state === 'armed') {
		console.log(`husky hooks armed: ${report.declared.join(', ')}`);
		process.exit(0);
	}

	console.error("\nThis checkout's git hooks are not armed.");
	console.error(`  ${report.detail}`);
	console.error(`  declared in .husky/: ${report.declared.join(', ') || '(none)'}`);
	console.error(`  not installed: ${report.missing.join(', ') || '(none)'}`);
	console.error(`
  .husky/_ is gitignored, so \`git worktree add\` never creates it and git runs
  no hook at all -- without an error, and without a message. Every commit and
  every push succeeds with nothing checked.

  Fix it in this checkout:

      npx husky

  Then re-run. Set SKIP_HOOKS=1 to pass this deliberately.
`);
	process.exit(1);
}
