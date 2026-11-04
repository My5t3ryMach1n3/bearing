#!/usr/bin/env bash
# Measures build time and test overhead for each prototype on the reminder worker. Usage: ./bench.sh [runs]
# Prints a markdown table. Every build uses its own GOCACHE so runs don't share work unless a row says so.
set -euo pipefail
cd "$(dirname "$0")"
RUNS=${1:-3}
HERE=$PWD
W=$(mktemp -d)
R=$HERE/reminder-worker
SCHED=$R/internal/schedule/scheduler.go
cp "$SCHED" "$W/scheduler.go.orig"
restore() { cp "$W/scheduler.go.orig" "$SCHED"; }
trap 'restore; rm -rf "$W"' EXIT
cat > "$W/settings.json" <<JSON
{"root":"$R","components":[
 {"id":"eventConsumer","path":"internal/consumer"},
 {"id":"scheduler","path":"internal/schedule"},
 {"id":"smsSender","path":"internal/sms"},
 {"id":"reminderStore","path":"internal/store"}]}
JSON
export BEARING_GO_TRACE_TAG='#<issue>/AC<n>' BEARING_GO_TRACE_SETTINGS=$W/settings.json
export BEARING_GO_TRACE_RUNTIME_SRC=$HERE/tools/bearingtrace XDG_CACHE_HOME=$W/xdg

now() { date +%s.%N; }
median() { sort -n | awk '{a[NR]=$1} END {print a[int((NR+1)/2)]}'; }
secs() { awk -v a="$1" -v b="$2" 'BEGIN {printf "%.2f", b-a}'; }

# Builds the prototypes' tools; times the first, cold build.
tools_build() {
  local t0; t0=$(now)
  (cd tools && GOCACHE=$W/tools-cache-$1 go build -o "$W/$1" "./cmd/$1")
  secs "$t0" "$(now)"
}

# test <mode> <gocache>: runs go test ./... the way `bearing test` would for that mode, with A's overlay generation
# included.
gotest() {
  local mode=$1 cache=$2
  rm -rf "$W/traces"
  case $mode in
    plain) (cd "$R" && GOCACHE=$cache go test -count=1 ./... >/dev/null) ;;
    A) "$W/overlay" -settings "$W/settings.json" -module "$R" -runtime tools/bearingtrace/trace.go -out "$W/a" >/dev/null
       (cd "$R" && GOCACHE=$cache BEARING_GO_TRACE_DIR=$W/traces GOFLAGS=-overlay=$W/a/overlay.json go test -count=1 ./... >/dev/null) ;;
    B) (cd "$R" && GOCACHE=$cache BEARING_GO_TRACE_DIR=$W/traces GOFLAGS=-toolexec=$W/toolexec go test -count=1 ./... >/dev/null) ;;
  esac
}

timed() { local t0; t0=$(now); "$@"; secs "$t0" "$(now)"; }

edit() { echo "// edit $RANDOM$RANDOM" >> "$R/internal/schedule/scheduler.go"; }

bench() {
  local mode=$1 flags=() out
  case $mode in
    A) flags=(GOFLAGS=-overlay=$W/a/overlay.json BEARING_GO_TRACE_DIR=$W/traces) ;;
    B) flags=(GOFLAGS=-toolexec=$W/toolexec BEARING_GO_TRACE_DIR=$W/traces) ;;
  esac
  out=$(cd "$R" && env GOCACHE="$W/cache-$mode-warm" "${flags[@]}" go test -count=1 -run '^$' -bench 'Format' -benchtime 200000x ./internal/sms)
  echo "$out" | awk '/^BenchmarkFormat-/ {s=$3} /^BenchmarkFormatDeep-/ {d=$3} END {print s, d}'
}

echo "Tool build (cold cache): overlay $(tools_build overlay)s, toolexec $(tools_build toolexec)s"
GOCACHE=$W/shared go build std 2>/dev/null || true
(cd "$R" && GOCACHE=$W/shared go test -count=1 ./... >/dev/null)

echo
echo "| Mode | Cold cache (s) | Cache from a plain build (s) | Warm (s) | After editing one file (s) | Format (ns/call) | Format, 50 frames deep (ns/call) |"
echo "| --- | --- | --- | --- | --- | --- | --- |"
for mode in plain A B; do
  cold=(); shared=(); warm=(); edited=()
  for i in $(seq "$RUNS"); do
    rm -rf "$W/cache-$mode" "$W/xdg" "$W/shared-$mode"
    cold+=("$(timed gotest "$mode" "$W/cache-$mode")")
    cp -r "$W/shared" "$W/shared-$mode"; rm -rf "$W/xdg"
    shared+=("$(timed gotest "$mode" "$W/shared-$mode")")
    warm+=("$(timed gotest "$mode" "$W/cache-$mode")")
    edit
    edited+=("$(timed gotest "$mode" "$W/cache-$mode")")
    restore
  done
  cp -r "$W/cache-$mode" "$W/cache-$mode-warm" 2>/dev/null || true
  [ "$mode" = A ] && "$W/overlay" -settings "$W/settings.json" -module "$R" -runtime tools/bearingtrace/trace.go -out "$W/a" >/dev/null
  read -r shallow deep < <(bench "$mode")
  rm -rf "$W/cache-$mode-warm"
  printf '| %s | %s | %s | %s | %s | %s | %s |\n' "$mode" \
    "$(printf '%s\n' "${cold[@]}" | median)" "$(printf '%s\n' "${shared[@]}" | median)" \
    "$(printf '%s\n' "${warm[@]}" | median)" "$(printf '%s\n' "${edited[@]}" | median)" "$shallow" "$deep"
done
