#!/usr/bin/env bash
# Clipboard bridge: Textractor -> yomu.
#
# Runs on the machine playing the game, not on the server. Wine shares the
# clipboard with the host, so Textractor's "Copy to Clipboard" extension is the
# whole transport out of the Proton prefix.
#
#   YOMU_URL=http://100.127.94.72:42139 YOMU_INGEST_TOKEN=... ./yomu-send.sh
#
# For a second visual novel, set both the work and the process it gates on:
#   YOMU_WORK=someothervn YOMU_GAME_PROCESS=someother.exe ./yomu-send.sh
#
# Steins;Gate Re:boot carries engine markup, so it also needs a dialect:
#   YOMU_WORK=steinsgate-reboot YOMU_DIALECT=sciadv \
#   YOMU_GAME_PROCESS=<exe>.exe ./yomu-send.sh
#
# Use the TAILSCALE address, not yomu.masshiro.pro: the ISP here blocks the
# VPS's public address from home, so the public route times out even though the
# service is healthy. The tailnet does not depend on the ISP and is a good deal
# faster anyway (~70ms vs a round trip through Caddy).
#
# The token is required either way. Over the public route /api/ingest bypasses
# Authentik at the edge -- this script cannot complete an interactive login --
# and over the tailnet nothing else is in front of it at all, so the shared
# secret is the only guard in both cases.
#
# Gate order is a performance decision, not a security one. Both gates still
# apply to everything that is sent; they are simply evaluated cheapest-first.
# That matters because the handler runs on EVERY clipboard change on the
# machine, and the machine is also playing the game: measured here, pgrep costs
# 26ms (it enumerates ~390 processes, and -x is no cheaper than -f -- the cost
# is enumeration, not reading cmdlines) and starting python with urllib costs
# 54ms. Both were being paid to discard a Discord copy. The kana/kanji test is
# a bash case with no fork at all, at 0.01ms, so it goes first and the
# expensive checks only run for text that is plausibly a game line.
#
# $EPOCHREALTIME is read as the first statement in the handler, before any fork.
# Dwell time is the entire input to the known-word model and every later hop adds
# latency, so the clock nearest the human wins. An earlier version timestamped
# after spawning a helper and recorded a flat ~20ms for every line -- it was
# measuring its own startup cost.

set -euo pipefail

export YOMU_URL="${YOMU_URL:-http://localhost:42139}"
export YOMU_INGEST_TOKEN="${YOMU_INGEST_TOKEN:-}"

if [ -z "${WAYLAND_DISPLAY:-}" ]; then
	export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
	for sock in "$XDG_RUNTIME_DIR"/wayland-*; do
		case "$sock" in *.lock) continue ;; esac
		[ -S "$sock" ] || continue
		WAYLAND_DISPLAY=$(basename "$sock")
		export WAYLAND_DISPLAY
		break
	done
fi
[ -n "${WAYLAND_DISPLAY:-}" ] || {
	echo "No Wayland socket. Is the session running?" >&2
	exit 1
}

# Which games to forward for, and what to tag their text with.
#
# The clipboard is shared with everything on the machine, so a game must be
# running for anything to be sent -- without that the bridge relays whatever you
# copy, and it has already relayed an ingest token pasted from a setup command
# straight into the line store. Two independent gates guard that: this one, and
# a kana check.
#
# Detection happens per line rather than at startup, so switching games means
# switching games. Nothing here needs restarting, and text can never be filed
# under the novel you were reading an hour ago.
export YOMU_GAMES="${YOMU_GAMES:-$(cd -- "$(dirname -- "$0")" && pwd)/games.conf}"
[ -r "$YOMU_GAMES" ] || {
	echo "No game registry at $YOMU_GAMES" >&2
	exit 1
}

# Setting YOMU_WORK pins everything and skips detection, for a one-off or a game
# not worth adding to the registry.
export YOMU_WORK="${YOMU_WORK:-}"
export YOMU_WORK_TITLE="${YOMU_WORK_TITLE:-}"
export YOMU_DIALECT="${YOMU_DIALECT:-}"
export YOMU_GAME_PROCESS="${YOMU_GAME_PROCESS:-}"

# Where the last forwarded line is remembered, so the hook re-emitting it does
# not cost a full send each time. Runtime dir, not $HOME: it is scratch state
# that should not survive a reboot.
export YOMU_BRIDGE_STATE="${XDG_RUNTIME_DIR:-/tmp}/yomu-bridge-last"

if [ -n "$YOMU_WORK" ]; then
	echo "bridging clipboard -> $YOMU_URL/api/ingest  (pinned to $YOMU_WORK)"
else
	echo "bridging clipboard -> $YOMU_URL/api/ingest"
	echo "watching for:"
	sed -e 's/#.*//' -e '/^[[:space:]]*$/d' "$YOMU_GAMES" |
		while IFS='|' read -r proc slug _title _dialect; do
			printf '  %-16s -> %s\n' "$(echo "$proc" | tr -d ' ')" "$(echo "$slug" | tr -d ' ')"
		done
fi
echo "Ctrl-C to stop."

exec wl-paste --type text --watch bash -c '
  ts=$EPOCHREALTIME
  # A builtin, so the reject path forks nothing at all. read returns non-zero at
  # EOF having set the variable, which is why the failure is ignored.
  IFS= read -r -d "" text || true

  # Gate 1, and free: kana or kanji. Every line this VN produces has some;
  # almost nothing you copy by accident does. A bash case forks nothing, so a
  # Discord copy now costs about a hundredth of a millisecond instead of the
  # 80ms it used to spend discovering the same thing inside python.
  #
  # Ranges compare bytewise when no locale is set, which is why this is correct
  # rather than lucky: ASCII bytes cannot fall inside a three-byte CJK sequence.
  case $text in
    *[ぁ-ゟ]*|*[ァ-ヿ]*|*[一-鿿]*) ;;
    *) exit 0 ;;
  esac

  # Gate 2, also free: the hook re-emits the line already on screen, several
  # times, within a second. The server discards those, but only after they have
  # crossed the network -- and each one was costing a pgrep and a python here.
  prev=""
  [ -f "$YOMU_BRIDGE_STATE" ] && prev=$(<"$YOMU_BRIDGE_STATE")
  prev_ts=${prev%%$'"'"'\n'"'"'*}
  prev_text=${prev#*$'"'"'\n'"'"'}
  prev_ts=${prev_ts%%.*}
  case $prev_ts in *[!0-9]*|"") prev_ts=0 ;; esac
  if [ "$text" = "$prev_text" ] && [ $(( ${ts%%.*} - prev_ts )) -lt 2 ]; then
    exit 0
  fi

  # Gate 3, and now rarely reached: which game is running.
  #
  # One process listing for every game rather than a pgrep each, and matched
  # against whole process names -- a substring match would let "sgre" pick up an
  # editor with the file open.
  if [ -z "$YOMU_WORK" ]; then
    running=$(ps -eo comm= 2>/dev/null)
    nl="
"
    while IFS="|" read -r proc slug title dialect; do
      proc=$(echo "$proc" | tr -d " \t")
      case $proc in ""|"#"*) continue ;; esac
      case "$nl$running$nl" in
        *"$nl$proc$nl"*)
          YOMU_WORK=$(echo "$slug" | sed "s/^[[:space:]]*//;s/[[:space:]]*$//")
          YOMU_WORK_TITLE=$(echo "$title" | sed "s/^[[:space:]]*//;s/[[:space:]]*$//")
          YOMU_DIALECT=$(echo "$dialect" | sed "s/^[[:space:]]*//;s/[[:space:]]*$//")
          break ;;
      esac
    done < "$YOMU_GAMES"
    # Nothing recognised is running, so this is something else you copied.
    [ -n "$YOMU_WORK" ] || exit 0
    export YOMU_WORK YOMU_WORK_TITLE YOMU_DIALECT
  elif [ -n "$YOMU_GAME_PROCESS" ] && ! pgrep -f "$YOMU_GAME_PROCESS" >/dev/null 2>&1; then
    exit 0
  fi

  printf "%s\n%s" "$ts" "$text" > "$YOMU_BRIDGE_STATE"

  # python only for the send itself. It is the slowest thing here and also the
  # only one that gets JSON escaping of arbitrary Japanese right, which matters
  # more than 54ms on a line you are about to spend a minute reading.
  printf "%s" "$text" | exec python3 -c "
import json, os, sys, urllib.request

text = sys.stdin.read()
if not text.strip():
    sys.exit(0)

payload = json.dumps({
    \"source\": \"clipboard\",
    \"text\": text,
    \"ts\": int(float(sys.argv[1]) * 1000),
    \"work\": os.environ.get(\"YOMU_WORK\") or None,
    \"title\": os.environ.get(\"YOMU_WORK_TITLE\") or None,
    \"dialect\": os.environ.get(\"YOMU_DIALECT\") or None,
}).encode()

headers = {\"content-type\": \"application/json\"}
token = os.environ.get(\"YOMU_INGEST_TOKEN\")
if token:
    headers[\"authorization\"] = \"Bearer \" + token

req = urllib.request.Request(
    os.environ[\"YOMU_URL\"] + \"/api/ingest\",
    data=payload,
    headers=headers,
)
try:
    urllib.request.urlopen(req, timeout=5).read()
except Exception as e:
    print(f\"send failed: {e}\", file=sys.stderr)
" "$ts"
'
