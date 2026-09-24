# yomu

A reading assistant for Japanese visual novels, built around one idea: **the tool
should learn what you don't know by watching you read**, and mine flashcards from
the words that actually cost you time — not from a frequency list.

Target: 魔法少女ノ魔女裁判 (Magical Girl Witch Trials), Steam, Japanese-only.

## Why not just use Textractor and Yomitan

For plain reading, that stack is most of the way there and works today. yomu
exists for the two things it structurally cannot do:

1. **Friction telemetry.** Yomitan does not own your SRS, and your SRS does not
   watch you read. Owning both ends means lookups, re-lookups, dwell time and
   translation reveals can rank mining candidates by real difficulty.
2. **Spoiler-safe story context.** A rolling digest plus append-only character
   cards, every fact stamped with the line it was learned at and filtered to
   `line_index <= current`. This is not only a spoiler feature — 40k lines cannot
   fit in a prompt, so the compression was required anyway, and spoiler-safety
   falls out of it for free.

## Design rules

These are load-bearing. Breaking them makes the tool actively worse than nothing.

- **Translation is gated.** Furigana and word definitions are free; a full English
  sentence costs a deliberate second click and is logged. Otherwise the whole VN
  gets read in English through a Japanese-shaped window.
- **Mining produces candidates, not cards.** Batch approval at session end.
  Auto-mining floods the deck and kills the review habit inside a week.
- **Telemetry ships with the reader, not after it.** Dwell time cannot be
  collected retroactively. Every uninstrumented session is lost permanently.
- **Never let untagged dwell reach the model.** A skim recorded as reading
  teaches it that everything is known, which is exactly inverted.
- **Narration and dialogue are different problems.** Anime is overwhelmingly
  dialogue, so 地の文 is the register with no listening scaffold behind it and
  defaults to heavier support.

## Architecture

```
[Proton prefix]  manosaba.exe (Unity IL2CPP) <-- Textractor (Chenx221 fork)
                                                  | Copy to Clipboard
[Linux host]     bridge/yomu-send.sh -------------+
                        | POST /api/ingest
[yomu]           SvelteKit + SQLite --> SSE --> reader
                        `--> Lattice API (flashcards, hours, metrics)
```

The tokenizer and dictionary run **in the browser**, not on the server: the
machine playing the game has spare cores, and the VPS does not.

Both come from **kotoba** (`../kotoba`, `masshirodev/kotoba`, private), the
Japanese lookup yomu shares with tsundoku since 2026-09-24: tokenizing
(kuromoji), furigana, romaji, name merging, the mining rules and the card
itself (`composeCard`), and JMdict on the server (`kotoba/server`, wrapped by
`src/lib/server/dict.ts`). yomu keeps what's its own: the model's half of a
card (`src/lib/enrich.ts`), works, the parser, explanations. kotoba is a
path dependency (`"kotoba": "link:../kotoba"`), so **a checkout of it has to
sit beside yomu** wherever yomu is built: `yarn install` there once, and
`yarn prepare` copies its kuromoji dictionary into `static/dict`. JMdict is
`YOMU_JMDICT`, else `KOTOBA_JMDICT`, else the shared
`~/.local/share/kotoba/jmdict.db` (`yarn build:dict --out …` makes one).

Ingest is source-agnostic. The clipboard bridge posts today; a TextractorCLI
reader or an OCR fallback would post the same shape, and nothing downstream
knows the difference.

Everything yomu knows is scoped to a **work** — one visual novel. Story
context, character readings, mined vocabulary and reading pace all belong to
one, so a second novel cannot be explained using the first one's plot. See
[`doc/WORKS.md`](doc/WORKS.md), which also covers per-work engine markup and
what to set on the bridge when starting a new game.

## Development

```sh
yarn install
yarn dev            # port 42139
yarn run check      # NOT `yarn check` -- yarn 1 has a builtin that shadows it
yarn lint
yarn test
```

The parser is pure and tested against real Phase 0 capture output, so it can be
iterated without launching the game — which otherwise costs a full Proton start
per sample.

## Capturing from the game

On the machine running the game, with Textractor attached and Copy to Clipboard
enabled on the dialogue thread:

```sh
bridge/yomu
```

That is the whole invocation, for any game. The bridge works out which of the
games in [`bridge/games.conf`](bridge/games.conf) is running and tags the text
with it, per line — so switching games means switching games, with nothing to
restart and no way to file text under the novel you were reading an hour ago.

Adding a game is one line in that file: its process name, a work slug, a title,
and which engine markup its text carries.

Credentials live in `${XDG_CONFIG_HOME:-~/.config}/yomu/bridge.env`, outside the
repository, because a token in a working tree eventually gets committed:

```sh
mkdir -p ~/.config/yomu
cat > ~/.config/yomu/bridge.env <<'EOF'
# The tailnet address, not the public one, if the ISP blocks the VPS from home
YOMU_URL=http://100.127.94.72:42139
YOMU_INGEST_TOKEN=<from yomu/.env on the server>
EOF
chmod 600 ~/.config/yomu/bridge.env
```

Nothing is forwarded unless a known game is running and the text contains kana
or kanji. Both gates are on the sending machine on purpose: a password or a
token that is never sent cannot be stored, logged or leaked by anything
downstream.

## Deployment

Hosted at **https://yomu.masshiro.pro**, behind Caddy and gated by Authentik
forward-auth like the rest of the homelab.

```sh
cd ../ansible && ansible-playbook playbooks/deploy.yml -e service=yomu
```

The image builds kotoba in from `../kotoba` (compose's `additional_contexts`;
by hand, `docker build --build-context kotoba=../kotoba .`), so the host
building it needs a checkout of `masshirodev/kotoba` beside yomu.

`/api/ingest` is the one path Caddy lets past Authentik, because the bridge runs
on the machine playing the game and cannot complete an interactive login. It is
guarded instead by a bearer token (`YOMU_INGEST_TOKEN`, read from `yomu/.env`),
checked in `src/lib/server/auth.ts`. In production a missing token makes the
endpoint refuse rather than accept unauthenticated writes — forgetting a variable
should not quietly open a write endpoint to the internet.

`/api/stream` and `/api/events` are only ever called by the browser, so they stay
behind Authentik with the reader itself.

Note that Caddy's `Caddyfile` is **baked into its image**, not bind-mounted, so
editing it does nothing until caddy is redeployed.

### Reaching it from home

The ISP blocks the VPS's public address from the machine that plays the game, so
`https://yomu.masshiro.pro` times out there even when the service is healthy.
yomu is therefore also published on the **Tailscale interface only** —
`100.127.94.72:42139`, configurable via `YOMU_BIND_ADDR`/`YOMU_BIND_PORT`. Never
bind it to a wildcard address: the tailnet binding is the only thing keeping
that port off the public internet.

That route bypasses Caddy and therefore Authentik. It is an acceptable trade on
a private single-owner tailnet, and `/api/ingest` still requires its bearer
token — but it is a real trade. The public hostname remains the way in from
anywhere else, and stays gated.

## Status

Phases 0-4 are done and deployed: the hook is verified and needs no cleanup
layer, a separate speaker-name thread exists (`TMPro_set_text`), and the reader
tokenises in-browser with okurigana-aware furigana, JMdict definitions,
merged character names, friction telemetry, spoiler-safe explanations, and
mining into Lattice.

Still open: the summariser that writes story digests and character facts (the
tables, filter and rendering exist and are tested, but nothing populates them
yet, so explanations currently get the recent-lines window only), and Phase 5's
known-word model, which needs weeks of real reading before it is worth building.

Full plan and phase breakdown live in the Lattice project `yomu` and its board.
