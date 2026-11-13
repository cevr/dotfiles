#!/usr/bin/env bash
# Moves ~/Developer onto its own APFS volume (setup.sh) and keeps rift and git
# worktree clones as clones. Rerun it to resume; it never deletes: the old tree
# and the old caches go to ~/.Trash once the copy verifies.
#
#   migrate.sh                     run or resume the whole migration
#   migrate.sh preflight [ROOT...] list what uses ROOT (default ~/Developer and the two
#                                  caches) and what to quit; exit 1 when anything does
#   migrate.sh copy ORIGIN SRC DST copy SRC into DST, where ORIGIN is the path
#                                  the tree's worktree links name (used by test.sh)
#   migrate.sh move-cache CACHE TARGET
#                                  move one cache to TARGET behind a link (used by test.sh)
set -euo pipefail
PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH

rsync=/opt/homebrew/bin/rsync
# -N keeps creation times; -HAX hard links, ACLs and extended attributes.
rsync_flags=(-aHAXN --numeric-ids)
dev=$HOME/Developer
old=$HOME/Developer.pre-volume
trash=${DEVELOPER_MIGRATE_TRASH:-$HOME/.Trash}
# The after check's records: the symlinks into ~/Developer, and fseventsd samples.
state=${DEVELOPER_VOLUME_STATE:-$HOME/.local/state/developer-volume}
uid=$(id -u)
rift_db=${DEVELOPER_MIGRATE_RIFT_DB:-"$HOME/Library/Application Support/rift/rift.sqlite"}
syncthing_config=${DEVELOPER_MIGRATE_SYNCTHING_CONFIG:-"$HOME/Library/Application Support/Syncthing/config.xml"}
opencode_config=$HOME/.config/opencode/opencode.json
launch_agents=$HOME/Library/LaunchAgents
# Caches that move onto the volume, as "<path>:<name under ~/Developer/.cache>". bun
# clones packages out of its cache, and clones cannot cross volumes; okra's repo cache
# is source trees that gain from no Spotlight index and no FSEvents log.
caches=("$HOME/.bun/install/cache:bun" "$HOME/.cache/repo:repo")
# Agent transcripts and state, moved only with --with-transcripts, as "<path>:<name under
# ~/Developer/.agents>". By default they stay on the FileVault volume: they hold
# conversation text and pasted secrets, and they write little.
transcripts=("$HOME/.claude:claude" "$HOME/.codex:codex" "$HOME/.local/share/opencode:opencode-share" "$HOME/.local/state/opencode:opencode-state")
with_transcripts=false
# Free space kept in the shared APFS container while copying.
reserve_kb=${DEVELOPER_MIGRATE_RESERVE_KB:-$((20 * 1024 * 1024))}
# Removed rifts wait in .rifts/<repo>/.trash for `rift gc`; they are not copied.
# `rift gc` drops a trash row whose directory is gone and exits 0 (measured, rift 0.0.13).
trash_pattern='.rifts/*/.trash/'
# Files the volume makes for itself at its root, and the caches moved there.
volume_files=(/.fseventsd/ /.dotfiles-developer-volume /.Spotlight-V100/ /.Trashes/ /.TemporaryItems/ /.DocumentRevisions-V100/ /.cache/ /.agents/)

die() { printf 'developer migrate: %s\n' "$*" >&2; exit 1; }
say() { printf '==> %s\n' "$*"; }
avail_kb() { df -kP "$1" | awk 'NR == 2 { print $4 }'; }
used_kb() { du -sk "$1" 2>/dev/null | awk '{ print $1 }'; }
gib() { awk -v k="$1" 'BEGIN { printf "%.1f GiB", k / 1048576 }'; }

# Prints "<worktree>\t<main checkout>" for each worktree whose files are clones
# of a main checkout in the tree, both relative to SRC: git worktrees and rift's
# parent links (a rift is a full clone, its own .git included, of its parent).
worktrees() {
    local origin=$1 src=$2 file line gitdir t w
    while IFS= read -r -d '' file; do
        t=${file%/.git}
        IFS= read -r line < "$file" || true
        [[ $line == 'gitdir: '* ]] || continue
        gitdir=${line#gitdir: }
        # Submodules also have a .git file; only worktrees point at .git/worktrees.
        [[ $gitdir == */.git/worktrees/* ]] || continue
        w=${gitdir%/.git/worktrees/*}
        case $w in
            "$origin"/*) w=$src/${w#"$origin"/} ;;
            /*) continue ;;
            *) w=$(cd "$t" && cd "$w" 2>/dev/null && pwd -P) || continue ;;
        esac
        [[ $w == "$src"/* && -d $w ]] || continue
        printf '%s\t%s\n' "${t#"$src"/}" "${w#"$src"/}"
    done < <(find "$src" \( -name node_modules -o -path '*/.rifts/*/.trash' -o \( -name .git -type d \) \) -prune -o -name .git -type f -print0)
    if [[ -f $rift_db ]]; then
        sqlite3 -readonly -separator $'\t' "$rift_db" \
            'select c.path, p.path from rift c join rift p on p.id = c.parent_id' |
        while IFS=$'\t' read -r t w; do
            [[ $t == "$origin"/* && $w == "$origin"/* ]] || continue
            t=${t#"$origin"/} w=${w#"$origin"/}
            [[ -d $src/$t && -d $src/$w ]] || continue
            printf '%s\t%s\n' "$t" "$w"
        done
    fi
}

# Recreates worktree T in DST as a clone of its already-copied main checkout W,
# then lets rsync rewrite only what differs. Checksums, not times: package
# files share fixed mtimes across versions, so equal size and mtime proves nothing.
copy_worktree() {
    local src=$1 dst=$2 map=$3 t=$4 w=$5 entry name
    (($(avail_kb "$dst") > reserve_kb)) || die "Less than $(gib "$reserve_kb") free; stopped before $t. Free space and rerun."
    if [[ ! -e $dst/$t ]]; then
        mkdir -p "$dst/$t"
        for entry in "$dst/$w"/* "$dst/$w"/.[!.]* "$dst/$w"/..?*; do
            [[ -e $entry || -L $entry ]] || continue
            name=${entry##*/}
            # A git worktree's .git is a file of its own; a rift's .git directory is a clone.
            if [[ $name == .git ]] && ! [[ -d $src/$t/.git && ! -L $src/$t/.git ]]; then continue; fi
            # Never clone a directory that holds a worktree into that worktree.
            if awk -F '\t' -v p="$w/$name" '$1 == p || index($1, p "/") == 1 { hit = 1 } END { exit !hit }' "$map"; then continue; fi
            cp -c -p -R "$entry" "$dst/$t/"
        done
    fi
    "$rsync" "${rsync_flags[@]}" --checksum --delete "$src/$t/" "$dst/$t/"
}

copy_tree() {
    local origin=$1 src=$2 dst=$3 work map exclude t w copied=0
    src=$(cd "$src" && pwd -P)
    dst=$(cd "$dst" && pwd -P)
    work=$(mktemp -d)
    map=$work/worktrees
    exclude=$work/exclude
    say "Finding worktrees in $src"
    worktrees "$origin" "$src" | sort -u -t $'\t' -k1,1 > "$map"
    if cut -f1 "$map" | grep -q '[][*?\\]'; then die 'A worktree path holds an rsync wildcard character; rename it first.'; fi
    { printf '%s\n' "$trash_pattern"; printf '%s\n' "${volume_files[@]}"; cut -f1 "$map" | sed 's#^#/#; s#$#/#'; } > "$exclude"
    say "$(wc -l < "$map" | tr -d ' ') worktrees will be cloned from their main checkouts"

    local need_kb=$(($(used_kb "$src") - $(used_kb "$dst")))
    while IFS=$'\t' read -r t w; do need_kb=$((need_kb - $(used_kb "$src/$t"))); done < "$map"
    for t in "$src"/*/.rifts/*/.trash "$src"/.rifts/*/.trash; do
        [[ -d $t ]] && need_kb=$((need_kb - $(used_kb "$t")))
    done
    (($(avail_kb "$dst") - need_kb > reserve_kb)) ||
        die "Copy needs about $(gib "$need_kb") but only $(gib "$(avail_kb "$dst")") is free. Free space (for example \`rift gc\`) and rerun."

    say "Copying main checkouts ($(gib "$need_kb"))"
    local progress=()
    [[ -t 1 ]] && progress=(--info=progress2)
    "$rsync" "${rsync_flags[@]}" ${progress[@]+"${progress[@]}"} --exclude-from="$exclude" "$src/" "$dst/"

    cp "$map" "$work/pending"
    while [[ -s $work/pending ]]; do
        : > "$work/next"
        cut -f1 "$work/pending" > "$work/waiting"
        while IFS=$'\t' read -r t w; do
            # A worktree of a worktree (a rift of a rift) waits for its parent.
            if grep -Fxq -e "$w" "$work/waiting"; then
                printf '%s\t%s\n' "$t" "$w" >> "$work/next"
                continue
            fi
            say "Cloning $t from $w"
            copy_worktree "$src" "$dst" "$map" "$t" "$w"
            copied=$((copied + 1))
        done < "$work/pending"
        cmp -s "$work/pending" "$work/next" && die 'Worktree parents form a cycle.'
        mv "$work/next" "$work/pending"
    done

    # Worktree copies moved the times of their parent directories; set them back.
    "$rsync" "${rsync_flags[@]}" --exclude-from="$exclude" "$src/" "$dst/"
    say 'Verifying'
    { printf '%s\n' "$trash_pattern"; printf '%s\n' "${volume_files[@]}"; } > "$exclude"
    # A volume root keeps its own creation time; ignore attribute changes on ./ alone.
    "$rsync" "${rsync_flags[@]}" --dry-run --delete --itemize-changes --exclude-from="$exclude" "$src/" "$dst/" |
        { grep -v '^\.d[^ ]* \./$' || true; } > "$work/diff"
    if [[ -s $work/diff ]]; then
        head -50 "$work/diff" >&2
        die "$dst differs from $src in $(wc -l < "$work/diff" | tr -d ' ') places (list above). Nothing was removed."
    fi
    say "Copy verified ($copied worktrees cloned)"
    rm -rf "$work"
}

# Does launch agent PLIST name a path under ROOT?
names() { [[ -f $1 ]] && grep -qF -e "$2/" -e "$2<" "$1"; }

# What to quit for a process, by its command name and line.
hint() {
    case $2 in
        *' serve --service'*) printf 'the OpenCode service: opencode service stop' ;;
        */mods/kernel/worker/*) printf 'an OpenCode kernel worker: it stops with opencode service stop' ;;
        */cmd/wake/job.ts*) printf 'an OpenCode job: let it end, or opencode service stop' ;;
        *herdr*) printf 'herdr (its panes run inside): herdr server stop' ;;
        *syncthing*) printf 'Syncthing: brew services stop syncthing' ;;
        *opencode*) printf 'an OpenCode TUI or session: quit it' ;;
        *) case $1 in
            *herdr*) printf 'herdr (its panes run inside): herdr server stop' ;;
            *) printf 'quit it (editor, agent, dev server, shell inside)' ;;
        esac ;;
    esac
}

# Prints "<pid>\t<command line>" for each process that holds a file or a directory
# (its cwd included) under a ROOT, or names a path under one on its command line.
# This script's own process and its children are left out.
holders() {
    local listing pids
    listing=$(ps -axo pid=,ppid=,command=)
    pids=$({
        lsof -nP -w -F pn 2>/dev/null | awk -v roots="$*" '
            BEGIN { n = split(roots, r, " ") }
            /^p/ { pid = substr($0, 2); next }
            /^n/ { f = substr($0, 2); for (i = 1; i <= n; i++) if (f == r[i] || index(f, r[i] "/") == 1) print pid }'
        printf '%s\n' "$listing" | awk -v roots="$*" '
            BEGIN { n = split(roots, r, " ") }
            { line = $0; sub(/^ *[0-9]+ +[0-9]+ /, "", line)
              for (i = 1; i <= n; i++) if (index(line, r[i] "/") || index(line " ", r[i] " ")) { print $1; break } }'
    } | sort -un | tr '\n' ' ')
    printf '%s\n' "$listing" | awk -v self="$$" -v pids="$pids" '
        { ppid[$1] = $2; line = $0; sub(/^ *[0-9]+ +[0-9]+ /, "", line); cmd[$1] = line }
        END {
            n = split(pids, want, " ")
            for (k = 1; k <= n; k++) {
                p = want[k]; if (!(p in cmd)) continue
                q = p; mine = 0
                while (q > 1 && (q in ppid)) { if (q == self) { mine = 1; break }; q = ppid[q] }
                if (!mine) print p "\t" cmd[p]
            }
        }' | sort -n
}

# Lists what uses ROOT... and what to quit; returns 1 when anything does.
preflight() {
    local roots=("$@") busy=0 pid line root path plist label
    while IFS=$'\t' read -r pid line; do
        [[ -n $pid ]] || continue
        printf '  pid %s  %s\n      quit %s\n' "$pid" "${line:0:120}" "$(hint "$(ps -o comm= -p "$pid" 2>/dev/null || true)" "$line")"
        busy=1
    done < <(holders "${roots[@]}")
    for root in "${roots[@]}"; do
        # The service loads its plugins from the dotfiles even when no file is open.
        if [[ -f $opencode_config ]] && grep -qF "\"$root/" "$opencode_config" &&
            pgrep -f -- ' serve --service' >/dev/null; then
            printf '  the OpenCode service loads plugins from %s\n      quit: opencode service stop\n' "$root"
            busy=1
        fi
        # Syncthing would see a folder vanish and come back while the copy runs.
        if [[ -f $syncthing_config ]] && pgrep -x syncthing >/dev/null; then
            while IFS= read -r path; do
                printf '  Syncthing syncs %s\n      quit: brew services stop syncthing\n' "$path"
                busy=1
            done < <(grep -o 'path="[^"]*"' "$syncthing_config" | sed 's/^path="//; s/"$//' |
                awk -v r="$root" '$0 == r || index($0, r "/") == 1')
        fi
        # A loaded agent may fire mid-copy and run from the half-copied tree.
        for plist in "$launch_agents"/*.plist; do
            names "$plist" "$root" || continue
            label=$(/usr/libexec/PlistBuddy -c 'Print :Label' "$plist" 2>/dev/null) || continue
            launchctl print "gui/$uid/$label" >/dev/null 2>&1 || continue
            printf '  launch agent %s runs from %s\n      quit: launchctl bootout gui/%s/%s\n' "$label" "$root" "$uid" "$label"
            busy=1
        done
    done
    return "$busy"
}

require_idle() {
    local report
    if report=$(preflight "$@"); then return; fi
    printf '%s\n' "$report" >&2
    die "These use $*. Quit them and rerun; nothing was moved."
}

# What to start again once the tree is on the volume.
restart_steps() {
    local plist label
    say 'Start again what you quit:'
    printf '  opencode service start\n  herdr\n'
    if [[ -f $syncthing_config ]] && ! pgrep -x syncthing >/dev/null &&
        grep -qF "path=\"$dev/" "$syncthing_config"; then printf '  brew services start syncthing\n'; fi
    for plist in "$launch_agents"/*.plist; do
        names "$plist" "$dev" || continue
        label=$(/usr/libexec/PlistBuddy -c 'Print :Label' "$plist" 2>/dev/null) || continue
        launchctl print "gui/$uid/$label" >/dev/null 2>&1 && continue
        printf '  launchctl bootstrap gui/%s %s\n' "$uid" "$plist"
    done
    printf '  rift gc   (clears rift'\''s list of the trash that stayed behind)\n'
}

# Moves cache CACHE to TARGET and leaves a link at its old path; the old directory
# goes to the Trash once the copy verifies. Resumable.
move_cache() {
    local cache=$1 target=$2 stamp
    stamp=$(date +%Y%m%d-%H%M%S)
    if [[ -d $cache && ! -L $cache ]]; then
        require_idle "$cache"
        say "Moving $cache onto the volume"
        mkdir -p "$target"
        "$rsync" "${rsync_flags[@]}" "$cache/" "$target/"
        local diff
        diff=$("$rsync" "${rsync_flags[@]}" --dry-run --delete --itemize-changes "$cache/" "$target/")
        if [[ -n $diff ]] && grep -vq '^\.d[^ ]* \./$' <<< "$diff"; then die "$target differs from $cache; nothing was removed."; fi
        mv "$cache" "$trash/${target##*/}-pre-volume-$stamp"
    fi
    if [[ ! -e $cache && ! -L $cache && -d $target ]]; then
        mkdir -p "$(dirname "$cache")"
        ln -s "$target" "$cache"
    fi
}

mounted() { [[ -d $1 && $(stat -f %d "$1") != $(stat -f %d "$(dirname "$1")") ]]; }

migrate() {
    [[ $(uname -s) == Darwin ]] || die 'This helper requires macOS.'
    [[ $uid != 0 ]] || die 'Run as your login user, not root.'
    [[ $("$rsync" --version 2>/dev/null) =~ version\ [3-9]\. ]] || die 'Needs rsync 3: brew install rsync.'
    command -v sqlite3 >/dev/null || die 'Needs sqlite3.'
    cd "$HOME"
    local here stamp entry
    here=$(cd "$(dirname "$0")" && pwd -P)
    stamp=$(date +%Y%m%d-%H%M%S)
    local cache_paths=() moves=("${caches[@]/%/:.cache}")
    if [[ $with_transcripts == true ]]; then
        printf '%s\n' 'Moving agent transcripts and state onto the UNENCRYPTED Developer volume (--with-transcripts).'
        moves+=("${transcripts[@]/%/:.agents}")
    fi
    for entry in "${moves[@]}"; do cache_paths+=("${entry%%:*}"); done

    # The symlinks into ~/Developer (dotfiles links, mostly), for the after check.
    if [[ ! -f $state/links-before.tsv ]]; then "$here/check.sh" --links; fi
    [[ -f $state/fseventsd.tsv ]] ||
        say "No fseventsd baseline in $state; the after check will have nothing to compare (check.sh --baseline)."

    if mounted "$dev"; then
        if [[ -d $old ]]; then
            require_idle "$dev" "$old" "${cache_paths[@]}"
        else
            say "$dev is already its own volume; checking it"
        fi
    elif [[ ! -e $old ]]; then
        require_idle "$dev" "${cache_paths[@]}"
        say "Moving $dev aside to $old"
        mv "$dev" "$old"
        mkdir "$dev"
    elif [[ -n $(ls -A "$dev" 2>/dev/null) ]]; then
        die "$old exists and $dev holds files but is not a volume; inspect both."
    else
        require_idle "$old" "${cache_paths[@]}"
    fi
    "$here/setup.sh"
    mounted "$dev" || die "$dev is not mounted after setup."

    if [[ -d $old ]]; then
        require_idle "$old" "$dev"
        copy_tree "$dev" "$old" "$dev"
    fi
    local path name parent
    for entry in "${moves[@]}"; do
        path=${entry%%:*} name=${entry#*:} parent=${name#*:} name=${name%%:*}
        move_cache "$path" "$dev/$parent/$name"
    done
    if [[ -d $old ]]; then
        mv "$old" "$trash/Developer.pre-volume-$stamp"
        say "The old tree is ~/.Trash/Developer.pre-volume-$stamp; empty the Trash to reclaim its space."
    fi
    say 'After check'
    "$here/check.sh" "$dev" || say 'The after check failed (above); see README, Recovery.'
    restart_steps
}

relocate() {
    # This script lives inside the tree it moves; run a copy from outside it.
    [[ ${DEVELOPER_MIGRATE_RELOCATED:-} == 1 ]] && return
    local here copy
    here=$(cd "$(dirname "$0")" && pwd -P)
    copy=$(mktemp -d)
    cp "$here/migrate.sh" "$here/setup.sh" "$here/check.sh" "$here/watch-bench.ts" "$copy/"
    # caffeinate keeps the Mac awake for the length of the copy.
    DEVELOPER_MIGRATE_RELOCATED=1 exec caffeinate -i "$BASH" "$copy/migrate.sh" "$@"
}

case ${1:-} in
    '' | --with-transcripts)
        [[ ${1:-} == --with-transcripts ]] && with_transcripts=true
        relocate "$@"
        migrate ;;
    preflight)
        shift
        if (($# == 0)); then set -- "$dev"; for entry in "${caches[@]}"; do set -- "$@" "${entry%%:*}"; done; fi
        if [[ ${1:-} == --with-transcripts ]]; then
            shift; set -- "$dev"; for entry in "${caches[@]}" "${transcripts[@]}"; do set -- "$@" "${entry%%:*}"; done
        fi
        preflight "$@" && say "Nothing uses $*." ;;
    copy) [[ $# == 4 ]] || die 'usage: migrate.sh copy ORIGIN SRC DST'; copy_tree "$2" "$3" "$4" ;;
    move-cache) [[ $# == 3 ]] || die 'usage: migrate.sh move-cache CACHE TARGET'; move_cache "$2" "$3" ;;
    *) die 'usage: migrate.sh [--with-transcripts | preflight [--with-transcripts | ROOT...] | copy ORIGIN SRC DST | move-cache CACHE TARGET]' ;;
esac
