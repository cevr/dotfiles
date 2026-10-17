#!/usr/bin/env bash
# Moves ~/Developer onto its own APFS volume (setup.sh) and keeps rift and git
# worktree clones as clones. Rerun it to resume; it never deletes: the old tree
# and the old bun cache go to ~/.Trash once the copy verifies.
#
#   migrate.sh                     run or resume the whole migration
#   migrate.sh copy ORIGIN SRC DST copy SRC into DST, where ORIGIN is the path
#                                  the tree's worktree links name (used by test.sh)
set -euo pipefail
PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH

rsync=/opt/homebrew/bin/rsync
# -N keeps creation times; -HAX hard links, ACLs and extended attributes.
rsync_flags=(-aHAXN --numeric-ids)
dev=$HOME/Developer
old=$HOME/Developer.pre-volume
rift_db=${DEVELOPER_MIGRATE_RIFT_DB:-"$HOME/Library/Application Support/rift/rift.sqlite"}
# Free space kept in the shared APFS container while copying.
reserve_kb=${DEVELOPER_MIGRATE_RESERVE_KB:-$((20 * 1024 * 1024))}
# Removed rifts wait in .rifts/<repo>/.trash for `rift gc`; they are not copied.
trash_pattern='.rifts/*/.trash/'
# Files the volume makes for itself at its root.
volume_files=(/.fseventsd/ /.dotfiles-developer-volume /.Spotlight-V100/ /.Trashes/ /.TemporaryItems/ /.DocumentRevisions-V100/ /.cache/)

die() { printf 'developer migrate: %s\n' "$*" >&2; exit 1; }
say() { printf '==> %s\n' "$*"; }
avail_kb() { df -kP "$1" | awk 'NR == 2 { print $4 }'; }
used_kb() { du -sk "$1" 2>/dev/null | awk '{ print $1 }'; }
gib() { awk -v k="$1" 'BEGIN { printf "%.1f GiB", k / 1048576 }'; }

# Prints "<worktree>\t<main checkout>" for each worktree whose files are clones
# of a main checkout in the tree, both relative to SRC: git worktrees (rift
# makes these) and rift's own parent links.
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
            [[ $name != .git ]] || continue
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
            # A worktree of a worktree waits for its parent.
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

# Prints the processes holding files or directories under $1.
holders() {
    lsof -nP -w -F pcn 2>/dev/null | awk -v root="$1" '
        /^p/ { pid = substr($0, 2); next }
        /^c/ { cmd = substr($0, 2); next }
        /^n/ { n = substr($0, 2); if (n == root || index(n, root "/") == 1) print pid "\t" cmd }' | sort -u
}

require_idle() {
    local busy
    busy=$(holders "$1")
    [[ -z $busy ]] && return
    printf '%s\n' "$busy" | awk -F '\t' '{ print "  " $2 " (pid " $1 ")" }' >&2
    die "These processes use $1. Quit them (editors, agents, dev servers, shells inside it) and rerun."
}

mounted() { [[ -d $1 && $(stat -f %d "$1") != $(stat -f %d "$(dirname "$1")") ]]; }

migrate() {
    [[ $(uname -s) == Darwin ]] || die 'This helper requires macOS.'
    [[ $(id -u) != 0 ]] || die 'Run as your login user, not root.'
    [[ $("$rsync" --version 2>/dev/null) =~ version\ [3-9]\. ]] || die 'Needs rsync 3: brew install rsync.'
    command -v sqlite3 >/dev/null || die 'Needs sqlite3.'
    cd "$HOME"
    local here stamp
    here=$(cd "$(dirname "$0")" && pwd -P)
    stamp=$(date +%Y%m%d-%H%M%S)

    if mounted "$dev"; then
        [[ -d $old ]] || { say "$dev is already its own volume; checking it"; "$here/setup.sh"; return; }
    elif [[ ! -e $old ]]; then
        require_idle "$dev"
        say "Moving $dev aside to $old"
        mv "$dev" "$old"
        mkdir "$dev"
    elif [[ -n $(ls -A "$dev" 2>/dev/null) ]]; then
        die "$old exists and $dev holds files but is not a volume; inspect both."
    fi
    "$here/setup.sh"
    mounted "$dev" || die "$dev is not mounted after setup."
    require_idle "$old"

    copy_tree "$dev" "$old" "$dev"

    # bun clones packages out of its cache, and clones cannot cross volumes.
    local cache=$HOME/.bun/install/cache
    if [[ -d $cache && ! -L $cache ]]; then
        say "Moving the bun cache onto the volume"
        mkdir -p "$dev/.cache/bun"
        "$rsync" "${rsync_flags[@]}" "$cache/" "$dev/.cache/bun/"
        mv "$cache" "$HOME/.Trash/bun-install-cache-$stamp"
        ln -s "$dev/.cache/bun" "$cache"
    fi

    mv "$old" "$HOME/.Trash/Developer.pre-volume-$stamp"
    say "Done. The old tree is ~/.Trash/Developer.pre-volume-$stamp; empty the Trash to reclaim its space."
}

relocate() {
    # This script lives inside the tree it moves; run a copy from outside it.
    [[ ${DEVELOPER_MIGRATE_RELOCATED:-} == 1 ]] && return
    local here copy
    here=$(cd "$(dirname "$0")" && pwd -P)
    copy=$(mktemp -d)
    cp "$here/migrate.sh" "$here/setup.sh" "$copy/"
    # caffeinate keeps the Mac awake for the length of the copy.
    DEVELOPER_MIGRATE_RELOCATED=1 exec caffeinate -i "$BASH" "$copy/migrate.sh" "$@"
}

case ${1:-} in
    '') relocate "$@"; migrate ;;
    copy) [[ $# == 4 ]] || die 'usage: migrate.sh copy ORIGIN SRC DST'; copy_tree "$2" "$3" "$4" ;;
    *) die 'usage: migrate.sh [copy ORIGIN SRC DST]' ;;
esac
