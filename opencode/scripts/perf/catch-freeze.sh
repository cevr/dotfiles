#!/usr/bin/env bash
# Watch one process's CPU (read-only, from /proc) and take a strobe deep recording when it stays
# busy: CPU >= THRESHOLD% for 3 polls in a row (2 s each). At most MAX recordings, for at most
# DURATION seconds. Usage: catch-freeze.sh <pid> <threshold %> <max recordings> <duration s> <log>
pid=$1; threshold=$2; max=$3; duration=$4; log=$5
strobe=~/.local/opt/strobe-0.14.0/package/strobe
hz=$(getconf CLK_TCK)
ticks() { awk '{print $14+$15}' "/proc/$pid/stat" 2>/dev/null || echo 0; }
prev=$(ticks); hot=0; taken=0; end=$((SECONDS + duration))
while [ $SECONDS -lt "$end" ] && [ "$taken" -lt "$max" ] && [ -d "/proc/$pid" ]; do
  sleep 2
  now=$(ticks); pct=$(( (now - prev) * 100 / hz / 2 )); prev=$now
  printf '%s\t%d\n' "$(date +%T)" "$pct" >> "$log"
  if [ "$pct" -ge "$threshold" ]; then hot=$((hot + 1)); else hot=0; fi
  if [ "$hot" -ge 3 ]; then
    echo "$(date +%T) busy ${pct}% for 6 s: recording" >> "$log"
    (cd /tmp && "$strobe" record "pid:$pid" --probes deep --for 30s 2>&1 | grep -E '^rec_' >> "$log")
    taken=$((taken + 1)); hot=0; prev=$(ticks)
  fi
done
echo "$(date +%T) done: $taken recordings" >> "$log"
