# Works

A **work** is one visual novel. It is the unit everything yomu knows is scoped
to: the story context, the character names, the mined vocabulary, the reading
pace.

yomu was built for a single VN and quietly assumed it everywhere. Nothing said
so — there was simply no column for it. Reading a second novel would not have
failed; it would have explained its lines using the first one's plot, offered
the first one's cast as name readings, and mined both into one queue. Wrong
answers that look like right ones, which is the worse kind of wrong.

## What a work owns

```sql
CREATE TABLE works (
  id         INTEGER PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,   -- normalised; ends up on flashcard tags
  title      TEXT NOT NULL,
  dialect    TEXT NOT NULL DEFAULT 'none',
  created_at INTEGER NOT NULL
);
```

`sessions.work_id` is the only foreign key that points at it. Everything else
reaches a work by joining through a session:

```
works ─┬─ sessions ─┬─ lines ── attempts
       │            └─ events            (the friction log)
       ├─ names                          (readings, incl. game-supplied ruby)
       ├─ story_digests, character_facts (Phase 3 story memory)
       └─ mining, mining_drafts          (per-work primary keys)
```

`names`, `mining` and `mining_drafts` were keyed by the surface or lemma alone,
which is the single-VN assumption written down as a constraint: the same word
met in two novels would collide, and mining it in one would mark it decided in
the other. SQLite cannot alter a primary key, so the migration rebuilds those
three tables with `(work_id, …)`.

### What is deliberately not scoped

**`explanations`** is keyed by a hash of the whole prompt, and the prompt
contains the story context. Two novels produce different context, therefore
different prompts, therefore different keys. The cache separated itself and
needed no migration — the same property that makes a line re-explained later in
the story a different question.

**`attempts`** hangs off `line_id`, and a line belongs to exactly one session,
which belongs to exactly one work. Adding a column would have created a second
answer to a question that already had one.

## `seq` means "how far into this story"

`seq` was allocated per session, so it restarted at zero every time a session
rolled over after thirty minutes idle. That is not cosmetic. `seq` is what the
spoiler boundary compares against, so a character fact learned at line 900 was
being filtered against a line numbered 3 — the boundary silently held back
context the reader had already earned.

It is now allocated per work and never restarts. The migration renumbered the
existing rows by insertion order.

## Choosing a work

One rule, everywhere: **an explicit slug wins, otherwise whichever work was read
most recently.** `resolveWork()` on the server, the `?work=` query parameter on
the client.

That default is what keeps yomu a single-click tool for the ordinary case of
having one novel open, while still letting a second exist.

Ingest is the exception, and deliberately: `workForIngest()` **creates** an
unknown slug rather than rejecting it. The bridge is configured on the machine
playing the game, and text should never need a setup step in the reader before
it can arrive. An unknown slug means a new novel was started, which is exactly
when the least friction is wanted.

## `WorkId` is branded, and that is not ceremony

```ts
export type WorkId = number & { readonly __brand: 'WorkId' };
```

Session ids, work ids, line ids and timestamps are all `number`. Scoping these
reads turned `contextLines(sessionId)` into a call that still compiled and
silently read the wrong story, and `currentSession(timestamp)` into one that
passed a clock reading as an id. Both typechecked cleanly.

Branding turned that into 42 compiler errors — every one a real call site that
needed to change. Anything that hands out a work id casts once, at the database
boundary, which is where the trust boundary genuinely is.

## Dialects: engine markup is per work

Phase 0 concluded that the raw hook emits clean Japanese and no cleanup layer
was needed. That was true of manosaba and false in general.

| dialect  | for                                                                     |
| -------- | ----------------------------------------------------------------------- |
| `none`   | a game whose hook emits clean text (manosaba)                           |
| `sciadv` | pause codes, colour spans, literal `\n`, and ruby (Steins;Gate Re:boot) |

Markup is stripped in `src/lib/markup.ts` before anything else looks at the
text. Left in, `%p-1;` and `#ff8A00;` are tokenised as words and ranked as
vocabulary worth studying.

### Ruby is kept, and it is the most valuable thing in the text

`運命石の扉` reads `シュタインズゲート`. No dictionary and no morphological
analyser will ever produce that. Game-supplied ruby goes into the same per-work
`names` table as character names, which already overrides the tokenizer in
sentence annotation and on cards — so the game answers the question yomu would
otherwise have to guess at, for exactly the words a tokenizer gets most wrong.

An engine reading only ever **fills a gap**. It never overwrites one corrected
by hand, because the engine has been seen to get them wrong.

**A run of ruby is one reading over one base, never character by character.**
The engine's own split is wrong in every sample observed — `凶` given `きょ`
where it reads `きょう`, `至` given `たる` where it reads `いたる`, `瀬` given
`せく` where it reads `せ` — and it is not even consistent about which side of
its character a bracket goes (`[ほう]鳳` against `牧[まき]`). Joining the run
sidesteps both problems and was correct for every sample.

Two things in that parser are knowingly uncertain and should be revisited:

- The spanning form `[おかべりんたろう,4]岡部倫太郎` is read as **N+1**
  characters. Every observed sample is `N=4` over a five-character base, so this
  is an assumption. It is a deliberately visible one — a wrong span shows up as
  furigana over the wrong characters on sight.
- There is **no catch-all** for unrecognised `%` codes. `%C` carries no
  terminator and the game's own title contains a semicolon, so `%CSTEINS;GATE`
  against a general `%\w+;` rule matches `%CSTEINS;` and eats the title. Codes
  are listed by name; an unknown one left visible is a bug report, one that
  silently swallowed text is not.

## Adding a second visual novel

One line in `bridge/games.conf`:

```
process        | work slug         | title               | dialect
sgre_steam.exe | steinsgate-reboot | STEINS;GATE RE:BOOT | sciadv
```

Then `bridge/yomu`, with no argument. Nothing needs creating in the reader
first: an unknown slug is created by the first line that arrives.

The process name is what gates forwarding, and it is matched against a **whole**
process name rather than a substring — `sgre` alone would otherwise be satisfied
by an editor with the file open. Linux truncates process names at 15 characters,
so check `ps -eo comm=` before adding a longer one.

Detection runs **per line**, not at startup. Switching games therefore means
switching games: there is nothing to restart, and no window in which text is
filed under the novel you were reading an hour ago. It costs one process listing
on the lines that reach it, which is only the ones that already look like game
text — see the gate order in `bridge/yomu-send.sh`.

Setting `YOMU_WORK` pins everything and skips detection, for a one-off or a game
not worth adding to the registry.

## Gotchas worth knowing

**The bus is scoped.** In-process fan-out from ingest to connected readers had
no idea what it was relaying, so a line from one novel would have been pushed
into a reader showing another. `subscribe(workId, fn)` and `publish(workId, …)`.

**The backlog is per work, across sessions.** It used to be
`recentLines(currentSession())`, which is empty by definition after a rollover —
so opening the reader after any break showed nothing at all. It is now the last
40 lines of the work, which is what "where I left off" means.

**Cards are tagged `yomu,<slug>`**, so a Lattice deck can be filtered to one
story.

**Sessions are per work.** Two novels read in the same evening are two sittings,
not one; sharing a session would put one story's pace and lookups into the
other's statistics.

**The migration runs at module import.** SvelteKit loads route modules lazily,
so a freshly deployed container has not migrated until the first API request
arrives. "Healthy" does not mean "migrated".

**This database runs in WAL mode.** `docker cp` of the `.db` alone silently
loses recent writes, and a stale `-wal` left beside a fresh copy replays over
it. Use `VACUUM INTO`, and remove the `-wal`/`-shm` sidecars before reading a
copy.
