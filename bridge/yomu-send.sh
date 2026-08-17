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
# this one, and a Japanese-content check in the handler below.
export YOMU_GAME_PROCESS="${YOMU_GAME_PROCESS:-manosaba.exe}"

exec wl-paste --type text --watch bash -c '
  ts=$EPOCHREALTIME
  # Cheapest gate first: nothing is forwarded when the game is not running.
  if [ -n "$YOMU_GAME_PROCESS" ] && ! pgrep -f "$YOMU_GAME_PROCESS" >/dev/null 2>&1; then
    exit 0
  fi
  exec python3 -c "
import json, os, sys, urllib.request

text = sys.stdin.read()
if not text.strip():
    sys.exit(0)

# Every line this VN produces contains kana or kanji; almost nothing you copy by
# accident does. Filtering HERE rather than server-side is the point -- a
# password or token that is never sent cannot be stored, logged, or leaked by
# something downstream.
import re
if not re.search(r\"[\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff]\", text):
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
