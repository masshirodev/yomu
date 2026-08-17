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

Ingest is source-agnostic. The clipboard bridge posts today; a TextractorCLI
reader or an OCR fallback would post the same shape, and nothing downstream
knows the difference.

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
# against the hosted instance
YOMU_URL=https://yomu.masshiro.pro \
YOMU_INGEST_TOKEN=<from yomu/.env on the server> \
  bridge/yomu-send.sh

# or locally
YOMU_URL=http://localhost:42139 bridge/yomu-send.sh
```

## Deployment

Hosted at **https://yomu.masshiro.pro**, behind Caddy and gated by Authentik
forward-auth like the rest of the homelab.

```sh
cd ../ansible && ansible-playbook playbooks/deploy.yml -e service=yomu
```

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

## Status

Phase 0 (hook verification) is complete. The hook is clean and needs no cleanup
layer; a separate speaker-name thread exists (`TMPro_set_text`). Phase 1 is the
reader, in progress. Full plan and phase breakdown live in the Lattice project
`yomu` and its board.
