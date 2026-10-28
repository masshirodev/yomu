# User Remarks

- Push to main if not specified.
- No coauthor on commits.

## This checkout

`AGENTS.local.md` is gitignored and describes this checkout on this machine
(its ports, what is safe to run beside it). Read it when it exists; never
commit it. The runtime pieces (launch and capture scripts, the Textractor
bridge) live outside the repository, in `~/yomu/`.

## Before a commit

```sh
yarn run check && yarn run lint && yarn run test
```

The hooks in `.husky/` enforce the cheap part: `pre-commit` formats and lints
the staged files, `pre-push` checks the hooks are armed, typechecks and runs
`hajime check --offline`, `commit-msg` refuses co-author trailers. Always
`yarn run <name>`, never bare `yarn <name>`. `doc/TESTING.md` says what runs
where; CI (`.github/workflows/ci.yml`) runs every suite on each push to `main`.

**Coverage is held at 38%** (lines, branches, functions and statements, over
`src/lib`): what yomu held when hajime adopted it. A change that drops it
adds the tests in the same commit; the floor is raised, never lowered.

The only page, `/`, is in the design sweep (`tests/design-sweep.e2e.ts`); a
new page goes into its manifest in the commit that makes it.

This repository is held to the house conventions by hajime (`.hajime.json`);
`hajime check` says what has drifted.

## Design briefs

Design briefs — the forwardable text a screen's design conversation starts
from — live in `doc/briefs/` as `UPPERCASE.md` files. Write new briefs there.
