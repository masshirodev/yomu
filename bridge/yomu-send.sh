#!/usr/bin/env bash
# Clipboard bridge: Textractor -> yomu.
#
# Runs on the machine playing the game, not on the server. Wine shares the
# clipboard with the host, so Textractor's "Copy to Clipboard" extension is the
# whole transport out of the Proton prefix.
#
#   YOMU_URL=http://100.127.94.72:42139 YOMU_INGEST_TOKEN=... ./yomu-send.sh
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

echo "bridging clipboard -> $YOMU_URL/api/ingest"
echo "Ctrl-C to stop."

# Only forward while the game is actually running. The clipboard is shared with
# everything else on the machine, so without this the bridge relays whatever you
# copy -- and it already relayed an ingest token pasted from a setup command,
# which then landed in the line store. Two independent gates guard that now:
# this one, and a Japanese-content check.
export YOMU_GAME_PROCESS="${YOMU_GAME_PROCESS:-manosaba.exe}"

# Where the last forwarded line is remembered, so the hook re-emitting it does
# not cost a full send each time. Runtime dir, not $HOME: it is scratch state
# that should not survive a reboot.
export YOMU_BRIDGE_STATE="${XDG_RUNTIME_DIR:-/tmp}/yomu-bridge-last"

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

  # Gate 3, and now rarely reached: is the game actually running.
  if [ -n "$YOMU_GAME_PROCESS" ] && ! pgrep -f "$YOMU_GAME_PROCESS" >/dev/null 2>&1; then
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
