# Design

What Yomu is for, what it deliberately is not, and the decisions that shape
it. A change that contradicts a decision here changes this file in the same
commit. The README's "Design rules" are the load-bearing product rules and
stay there; this file records the decisions about how the repository works.

## Goals

- A reader for Japanese visual novels that learns what the reader does not
  know by watching them read, and mines flashcards from the words that cost
  time (README, "Why not just use Textractor and Yomitan").
- Spoiler-safe story context: every fact stamped with the line it was learned
  at and filtered to the current line.

## Non-goals

- Replacing Yomitan for plain reading.
- Auto-mining: mining produces candidates, approved in a batch.
- Serving from the VPS: the tokenizer and dictionary run in the browser, on
  the machine playing the game.

## Decisions

- **kotoba is a path dependency** (`link:../kotoba`), shared with tsundoku.
  CI checks it out beside yomu from its `main`, as the workstation has it.
- **Runtime pieces live outside the repository**, in `~/yomu/` (the Steam
  launch wrapper, the capture script, Textractor). They are machine state, not
  code this repository ships.
- **The kuromoji dictionary is synced at install** (`postinstall`, from
  kotoba's `node_modules` into the gitignored `static/dict`). It moved out of
  `prepare` on 2026-10-28, when hajime took `prepare` for `svelte-kit sync`
  and husky; yarn runs both on every install, so nothing changed for a reader.
- **Held by hajime since 2026-10-28** (`.hajime.json`), at a coverage floor of
  38%: what `src/lib` held then, its components untested. The floor only rises.
