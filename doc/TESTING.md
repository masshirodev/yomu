# Testing

## Suites

| Suite   | Files                     | Runs in                                |
| ------- | ------------------------- | -------------------------------------- |
| Unit    | `src/**/*.{test,spec}.ts` | Vitest, Node                           |
| Browser | `tests/**/*.e2e.ts`       | Playwright, against a production build |

There is no component suite yet: the components are held by the design sweep
alone, which is why the floor over `src/lib` (which counts them) starts low.

## Commands

Always `yarn run <name>`, never bare `yarn <name>`: Yarn 1's builtin `check`
exits 0 in a second having typechecked nothing.

| Command                     | What                                                    |
| --------------------------- | ------------------------------------------------------- |
| `yarn run check`            | Hooks armed, then `svelte-check`                        |
| `yarn run lint`             | Prettier check, then ESLint                             |
| `yarn run test`             | Unit suite                                              |
| `yarn run test:coverage`    | The same, failing below 38% (see "Coverage")            |
| `yarn run test:e2e`         | Browser suite, the design sweep included (builds first) |
| `yarn run test:e2e:install` | Chromium for Playwright                                 |

## Three tiers: per change, per push, per release

After Kata and Kumiko, which both learned that a suite in `pre-push` stays
there long after it stops being cheap.

| Tier                | Run                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------- |
| **Per change**      | The specs of what you changed, and its e2e files                                         |
| **Per push**        | The `pre-push` hook: hooks armed, typecheck. Seconds, no suite                           |
| **Per `main` head** | The release tier, by CI (`.github/workflows/ci.yml`): every suite, whole, with the floor |
| **Per release**     | Ships only a commit the release tier passed                                              |

## Coverage

**The floor is 38%** for lines, branches, functions and statements, over
`src/lib` (where the logic lives; pages are held by the browser suite and the
design sweep). It is set in `vite.config.ts`, `coverage.thresholds`, and the
release tier fails below it. A change that lowers it adds tests in the same
commit; the floor is raised, never lowered.

## The design sweep

`tests/design-sweep.e2e.ts` opens every page at 1440 and 390 px and holds it
to the rules new screens kept breaking in Kumiko and Kata
(`tests/helpers/sweep.ts`):

- no `[object Object]`, `undefined` or `NaN` in what a person reads;
- no raw `{key}` in what a person reads;
- no page wider than the window;
- a card (`CARD` in the helper) keeps its text and controls 8 px inside its
  edges, unless it carries `data-flush`;
- no error thrown in the page or logged as one.

Its manifest (`PAGES`) names a path for every route under `src/routes`, and
the first test fails when a route is named nowhere: **a new screen goes into
the manifest in the commit that makes it**, or into `NOT_A_PAGE` with why.

The suite's server gets a database of its own (`YOMU_DB=temp/e2e/yomu.db`)
and no `LATTICE_TOKEN` (`playwright.config.ts`), so it never touches the line
store in `data/` or the real Lattice account. The sweep therefore sees the
reader empty, waiting for its first line.

Browser tests wait with `ready(page)` (`tests/helpers/e2e.ts`), never
`networkidle`.

## Where each check runs

| Check                        | pre-commit   | pre-push | Release tier |
| ---------------------------- | ------------ | -------- | ------------ |
| Prettier, ESLint             | staged files |          | tree         |
| Agent instruction budget     | yes          |          |              |
| House rules (`hajime check`) |              | yes      |              |
| Hooks armed                  |              | yes      |              |
| Typecheck                    |              | yes      | yes          |
| Unit, 38%                    |              |          | yes          |
| Browser + design sweep       |              |          | yes          |

## Git hooks

| Hook         | Runs                                                    | Skip flags                                       |
| ------------ | ------------------------------------------------------- | ------------------------------------------------ |
| `pre-commit` | lint-staged (ESLint, Prettier), `agent-docs-budget`     | `SKIP_LINT SKIP_FORMAT SKIP_AGENT_DOCS SKIP_ALL` |
| `pre-push`   | hooks armed, `yarn run check`, `hajime check --offline` | `SKIP_HOOKS SKIP_TYPECHECK SKIP_HAJIME SKIP_ALL` |
| `commit-msg` | refuses co-author trailers, `Claude-Session`, any emoji | `SKIP_COAUTHOR SKIP_EMOJI SKIP_ALL`              |

A worktree has no `.husky/_` until `npx husky` has run in it, and git then
runs no hook without saying so. `yarn run check` runs the armed check first
for that reason: it is the command an agent runs before committing anyway.

## Scratch files

Never write to `/tmp` directly: it is RAM on the workstation. A test that
needs a directory makes one under the repository's `temp/` (gitignored) and
removes it.
