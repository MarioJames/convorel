#!/usr/bin/env bash
# Drive the actual built release and offline installer without touching user state.
set -euo pipefail
cd "$(dirname "$0")/.."
dist_dir="$(realpath "${1:-dist}")"
acceptance_root="$(mktemp -d)"
acceptance_daemon=""
cleanup() {
  if [ -n "$acceptance_daemon" ]; then kill "$acceptance_daemon" 2>/dev/null || true; wait "$acceptance_daemon" || true; fi
  rm -rf "$acceptance_root"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for attempt in 1 2 3; do
  bash install.sh --dist-dir "$dist_dir" --prefix "$acceptance_root/prefix" --bin-dir "$acceptance_root/bin"
  "$acceptance_root/bin/convorel" version | grep -F "\"version\":\"$(cat VERSION)\""
done
test "$(find "$acceptance_root/prefix/versions" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 2
# Local doctor must work offline before any setup or daemon exists.
"$acceptance_root/bin/convorel" --config-dir "$acceptance_root/config" --state-dir "$acceptance_root/state" doctor --local > "$acceptance_root/doctor.json"
grep -F '"ok":true' "$acceptance_root/doctor.json"
grep -F '"configured":false' "$acceptance_root/doctor.json"
# Bundled skills work away from the source checkout, through an isolated daemon.
"$acceptance_root/bin/convorel" --config-dir "$acceptance_root/config" --state-dir "$acceptance_root/state" daemon > "$acceptance_root/daemon.log" 2>&1 &
acceptance_daemon=$!
for attempt in $(seq 1 100); do
  [ ! -S "$acceptance_root/state/convorel.sock" ] || break
  sleep 0.05
done
test -S "$acceptance_root/state/convorel.sock"
(cd "$acceptance_root" && "$acceptance_root/bin/convorel" --config-dir "$acceptance_root/config" --state-dir "$acceptance_root/state" skills install --target "$acceptance_root/skill")
test -f "$acceptance_root/skill/SKILL.md"
kill "$acceptance_daemon"
wait "$acceptance_daemon"
acceptance_daemon=""
bash install.sh --uninstall --prefix "$acceptance_root/prefix" --bin-dir "$acceptance_root/bin"
test ! -e "$acceptance_root/bin/convorel"
