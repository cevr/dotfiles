#!/usr/bin/env bash
# The "after" check: is DIR (default ~/Developer) the Developer volume, set up as setup.sh
# leaves it? Read-only, except that it appends its fseventsd sample to the state
# directory's history. Prints one line per check and exits 1 when any fails.
#
#   check.sh [DIR]       run the checks
#   check.sh --baseline  sample fseventsd's CPU as the "before" value (run it on an
#                        ordinary work day, before migrate.sh)
#   check.sh --links     record the symlinks under ~ that point into ~/Developer
#                        (migrate.sh does this before it moves anything)
#
#   volume     DIR is a mount point of its own (another device than its parent)
#   no_log     DIR/.fseventsd/no_log exists: no persistent FSEvents log
#   mdutil     `mdutil -s DIR` reports indexing disabled
#   watch      38 fs.watch calls under DIR take under 100 ms (watch-bench.ts)
#   links      for ~/Developer only: each symlink under ~ into ~/Developer resolves, each one
#              recorded before the move is still there, the bun and repo caches link onto
#              the volume, and the OpenCode config's paths under ~/Developer exist
#   fseventsd  for ~/Developer only: fseventsd's CPU over the sample, next to the baseline
#              (a report, never a failure)
set -uo pipefail
caller_bun=$(command -v bun || true)
PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH

here=$(cd "$(dirname "$0")" && pwd -P)
state=${DEVELOPER_VOLUME_STATE:-$HOME/.local/state/developer-volume}
sample_s=${DEVELOPER_CHECK_SAMPLE_S:-300}
developer=$HOME/Developer
failed=0
ok() { printf 'ok    %-9s %s\n' "$1" "$2"; }
bad() { printf 'FAIL  %-9s %s\n' "$1" "$2"; failed=1; }
info() { printf 'info  %-9s %s\n' "$1" "$2"; }

# fseventsd's CPU seconds over the sample, from its cumulative CPU time.
cpu_seconds() { ps -o time= -p "$1" | awk -F: '{ s = 0; for (i = 1; i <= NF; i++) s = s * 60 + $i; printf "%.2f\n", s }'; }
fseventsd_sample() {
    local pid a b
    pid=$(pgrep -x fseventsd | head -1)
    [[ -n $pid ]] || return 1
    a=$(cpu_seconds "$pid")
    sleep "$sample_s"
    b=$(cpu_seconds "$pid")
    awk -v a="$a" -v b="$b" 'BEGIN { printf "%.2f\n", b - a }'
}
record_sample() {
    local label=$1 cpu
    cpu=$(fseventsd_sample) || { echo 'fseventsd is not running'; return 1; }
    mkdir -p "$state"
    printf '%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%MZ)" "$label" "$sample_s" "$cpu" >> "$state/fseventsd.tsv"
    printf '%s CPU s over %s s' "$cpu" "$sample_s"
}

# Prints "<link>\t<target>" for each symlink under ~ (four levels deep, outside
# ~/Developer and ~/Library) whose target lies under ~/Developer.
links_into() {
    local link target dir
    find "$HOME" -maxdepth 4 \( -path "$developer" -o -path "$HOME/Library" -o -path "$HOME/.Trash" -o -name node_modules \
        -o -path "$HOME/.cache/repo" -o -path "$HOME/.bun/install" \) -prune -o -type l -print 2>/dev/null |
    while IFS= read -r link; do
        target=$(readlink "$link") || continue
        if [[ $target != /* ]]; then
            dir=$(cd "$(dirname "$link")" && cd "$(dirname "$target")" 2>/dev/null && pwd -P) || continue
            target=$dir/${target##*/}
        fi
        [[ $target == "$developer"/* ]] && printf '%s\t%s\n' "$link" "$target"
    done | sort
}

case ${1:-} in
    --baseline)
        result=$(record_sample before) || { echo "$result" >&2; exit 1; }
        echo "baseline: $result, in $state/fseventsd.tsv"
        exit 0 ;;
    --links)
        mkdir -p "$state"
        links_into > "$state/links-before.tsv"
        echo "$(wc -l < "$state/links-before.tsv" | tr -d ' ') links into $developer, in $state/links-before.tsv"
        exit 0 ;;
esac

dir=${1:-$developer}
[[ -d $dir ]] || { bad volume "$dir is not a directory"; exit 1; }

if [[ $(stat -f %d "$dir") != $(stat -f %d "$dir/..") ]]; then
    ok volume "$dir is its own volume"
else
    bad volume "$dir is on the same volume as its parent"
fi

if [[ -f $dir/.fseventsd/no_log && ! -L $dir/.fseventsd/no_log ]]; then
    ok no_log "$dir/.fseventsd/no_log"
else
    bad no_log "$dir/.fseventsd/no_log is missing"
fi

mdstate=$(mdutil -s "$dir" 2>&1 | sed -n '2p' | sed 's/^[[:space:]]*//')
if [[ $mdstate == 'Indexing disabled.' ]]; then
    ok mdutil "$mdstate"
else
    bad mdutil "${mdstate:-no answer} (want: Indexing disabled.)"
fi

bun=$HOME/.bun/bin/bun
[[ -x $bun ]] || bun=$caller_bun
if [[ -z $bun ]]; then
    bad watch 'bun is not installed'
elif result=$("$bun" "$here/watch-bench.ts" "$dir" 38 100 2>&1); then
    ok watch "$result"
else
    bad watch "$result"
fi

[[ $dir == "$developer" ]] || exit "$failed"

links=ok
miss() { bad links "$1"; links=bad; }
count=0
while IFS=$'\t' read -r link target; do
    count=$((count + 1))
    [[ -e $link ]] || miss "$link -> $target does not resolve"
done < <(links_into)
if [[ -f $state/links-before.tsv ]]; then
    while IFS=$'\t' read -r link target; do
        [[ -L $link ]] || { miss "$link (recorded before the move) is gone"; continue; }
        [[ -e $link ]] || miss "$link (recorded before the move) no longer resolves"
    done < "$state/links-before.tsv"
fi
for pair in "$HOME/.bun/install/cache:$dir/.cache/bun" "$HOME/.cache/repo:$dir/.cache/repo"; do
    link=${pair%%:*} target=${pair#*:}
    if [[ -e $link && (! -L $link || $(readlink "$link") != "$target" || ! -d $target) ]]; then
        miss "$link is not a link to $target"
    fi
done
config=$HOME/.config/opencode/opencode.json
if [[ -f $config ]]; then
    while IFS= read -r path; do
        [[ -e $path ]] || miss "$config names $path, which is missing"
    done < <(grep -o "\"$dir/[^\"]*\"" "$config" | tr -d '"' | sort -u)
fi
[[ $links == ok ]] && ok links "$count symlinks into $dir resolve; caches link onto the volume; OpenCode config paths exist"

if result=$(record_sample after); then
    before=$(awk -F '\t' '$2 == "before" { v = $4 " CPU s over " $3 " s, " $1 } END { print v }' "$state/fseventsd.tsv")
    info fseventsd "after: $result; before: ${before:-none (check.sh --baseline)}"
else
    info fseventsd "$result"
fi

exit "$failed"
