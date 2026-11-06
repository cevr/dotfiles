#!/usr/bin/env bash
# Per-process CPU% every INTERVAL seconds for DURATION seconds, from /proc/<pid>/stat (utime+stime).
# Read-only: it only reads /proc. Usage: cpu-timeline.sh <interval s> <duration s> <pid>...
interval=$1; duration=$2; shift 2
hz=$(getconf CLK_TCK)
declare -A prev
ticks() { awk '{print $14+$15}' "/proc/$1/stat" 2>/dev/null || echo 0; }
for p in "$@"; do prev[$p]=$(ticks "$p"); done
printf 'time'; for p in "$@"; do printf '\t%s' "$p"; done; printf '\n'
end=$((SECONDS + duration))
while [ $SECONDS -lt "$end" ]; do
  sleep "$interval"
  printf '%s' "$(date +%T)"
  for p in "$@"; do
    t=$(ticks "$p")
    printf '\t%d' $(( (t - prev[$p]) * 100 / hz / interval ))
    prev[$p]=$t
  done
  printf '\n'
done
