#!/usr/bin/env bash
# Moves the home directory and /tmp onto btrfs subvolumes of the workspace
# image (@home, @tmp), and turns git worktrees into Rifts. RUNBOOK.md has the
# order, the times and the rollback. Rerun any phase to resume it.
#
#   migrate.sh plan            what each phase would do; changes nothing
#   migrate.sh convert         turn worktrees into Rifts (as the home's owner)
#   migrate.sh home [--stop]   copy home and /tmp, then mount the subvolumes over
#                              them (root). --stop stops the owner's services
#                              first and starts them again after.
#   migrate.sh finish [--yes]  after check.sh passes: prune worktree entries and
#                              delete the moved-aside home and the old /tmp (root)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd -P)
# shellcheck source=linux/workbox-btrfs/common.sh
. "$here/common.sh"
conf=${WB_WORKTREES_CONF:-$here/worktrees.conf}
# sudo's PATH lacks the owner's ~/.local/bin.
workrift=${WB_WORKRIFT:-$(command -v workrift || echo "$wb_home/.local/bin/workrift")}
rsync_flags=(-aHAXS --numeric-ids)
# Private /tmp directories belong to running services' namespaces.
tmp_excludes=(--exclude=/systemd-private-* --exclude=/snap-private-tmp)

[[ $(uname -s) == Linux ]] || die 'requires Linux'

# --- Worktrees -----------------------------------------------------------

normalized_origin() {
    git -C "$1" remote get-url origin 2>/dev/null |
        sed -E 's#^[a-z+]+://##; s#^[^@/]+@##; s#:#/#; s#\.git$##; s#/+$##'
}

# Prints "<origin>\t<warm source>" for each warm source.
warm_sources() {
    local s
    as_user "$workrift" sources 2>/dev/null | while IFS= read -r s; do
        [[ -d $s/.git ]] && printf '%s\t%s\n' "$(normalized_origin "$s")" "$s"
    done
}

# The rule for a worktree: hold <reason>, release, or nothing.
rule_for() {
    local rel=$1 base=${1##*/}
    [[ -f $conf ]] || return 0
    awk -v rel="$rel" -v base="$base" '
        /^[ \t]*(#|$)/ { next }
        ($2 == rel || $2 == base) { verb = $1; $1 = ""; $2 = ""; r = $0; gsub(/^ +/, "", r); print verb (r == "" ? "" : " " r); exit }' "$conf" |
        { read -r line || true; printf '%s' "${line:-}"; }
}

# Prints "<worktree>\t<common dir>" for every git worktree under ~/Developer:
# a .git file pointing into some repository's .git/worktrees.
find_worktrees() {
    local file line gitdir t
    [[ -d $wb_home/Developer ]] || return 0
    while IFS= read -r -d '' file; do
        t=${file%/.git}
        IFS= read -r line < "$file" || true
        gitdir=${line#gitdir: }
        [[ $gitdir == */worktrees/* ]] || continue
        printf '%s\t%s\n' "$t" "$(git -C "$t" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
    done < <(find "$wb_home/Developer" \( -name node_modules -o \( -name .git -type d \) \) -prune -o -name .git -type f -print0)
}

# Prints "<action>\t<worktree>\t<branch>\t<warm source>\t<reason>" for each
# worktree; action is convert or keep. A kept worktree is copied as it is.
classify() {
    local sources t common rel rule branch origin source unpushed stashes
    sources=$(warm_sources)
    find_worktrees | sort | while IFS=$'\t' read -r t common; do
        rel=${t#"$wb_home/Developer/"}
        rule=$(rule_for "$rel")
        branch=$(git -C "$t" branch --show-current)
        [[ -n $branch ]] || branch=detached/${t##*/}
        origin=$(normalized_origin "$t")
        source=$(awk -F '\t' -v o="$origin" '$1 == o && o != "" { print $2; exit }' <<< "$sources")
        if [[ $rule == hold* ]]; then
            printf 'keep\t%s\t%s\t%s\theld: %s\n' "$t" "$branch" "$source" "${rule#hold }"
        elif [[ -z $source ]]; then
            printf 'keep\t%s\t%s\t\tno warm source for %s\n' "$t" "$branch" "${origin:-its origin}"
        else
            unpushed=$(git -C "$t" rev-list --count HEAD --not --remotes 2>/dev/null || echo 0)
            stashes=$(git -C "$t" stash list 2>/dev/null | wc -l)
            if [[ $rule != release ]] && ((unpushed + stashes > 0)); then
                printf 'keep\t%s\t%s\t%s\t%s unpushed commits, %s stashes; add "release %s" to worktrees.conf once its owner agrees\n' \
                    "$t" "$branch" "$source" "$unpushed" "$stashes" "${t##*/}"
            else
                printf 'convert\t%s\t%s\t%s\t%s unpushed commits carried as a local branch\n' "$t" "$branch" "$source" "$unpushed"
            fi
        fi
    done
}

converted_paths() { [[ -f $wb_converted ]] && cut -f3 "$wb_converted" || true; }

# Makes a Rift of worktree T on BRANCH from warm source S, and moves its
# commits (as a local branch of the source) and its uncommitted work.
convert_one() {
    local t=$1 branch=$2 s=$3 head rift busy
    busy=$(holders "$t")
    if [[ -n $busy ]]; then
        warn "skipped $t: in use by $(cut -f2 <<< "$busy" | sort -u | tr '\n' ' ')"
        return 0
    fi
    head=$(git -C "$t" rev-parse HEAD)
    say "Converting $t ($branch)"
    # A plain (not forced) fetch: it refuses to move a source branch that the
    # worktree's history does not contain.
    git -C "$s" fetch --quiet --no-tags "$t" "HEAD:refs/heads/$branch"
    # Run from the worktree, so workrift imports its gh stack metadata.
    rift=$(cd "$t" && WORKRIFT_SOURCE=$s "$workrift" create "$branch" | tail -n 1)
    [[ -d $rift ]] || die "workrift printed no workspace for $branch"
    git -C "$rift" merge-base --is-ancestor "$head" HEAD || die "$rift does not hold $head"
    local staged unstaged
    staged=$(git -C "$t" diff --cached --binary)
    unstaged=$(git -C "$t" diff --binary)
    [[ -z $staged ]] || git -C "$rift" apply --index --binary <<< "$staged"
    [[ -z $unstaged ]] || git -C "$rift" apply --binary <<< "$unstaged"
    (cd "$t" && git ls-files -z --others --exclude-standard | xargs -0r cp -a --reflink=auto --parents -t "$rift")
    mkdir -p "$(dirname "$wb_converted")"
    printf '%s\t%s\t%s\t%s\t%s\n' "${t##*/}" "$branch" "$t" "$rift" "$head" >> "$wb_converted"
    say "  -> $rift"
}

plan() {
    say 'Worktrees'
    classify | awk -F '\t' '{ printf "  %-8s %s [%s] %s\n", $1, $2, $3, $5 }'
    if [[ -s $wb_converted ]]; then
        say "Already converted ($wb_converted)"
        awk -F '\t' '{ printf "  %s -> %s\n", $3, $4 }' "$wb_converted"
    fi
    say "Space: home $(gib $(($(du -sxB1 "$wb_home" | cut -f1)))), /tmp $(gib $(($(du -sxB1 "$wb_tmp" 2>/dev/null | cut -f1))))"
    say "Processes holding files under $wb_home or $wb_tmp (migrate.sh home --stop stops their units):"
    holders "$wb_home" "$wb_tmp" | awk -F '\t' '{ print "  " $2 " (pid " $1 ")" }' | sort -u | head -40
}

convert() {
    [[ $(id -un) == "$WB_USER" ]] || die "run convert as $WB_USER"
    local action t branch s
    while IFS=$'\t' read -r action t branch s _; do
        [[ $action == convert ]] || continue
        if converted_paths | grep -Fxq -e "$t"; then continue; fi
        convert_one "$t" "$branch" "$s"
    done < <(classify)
    say "Converted worktrees are listed in $wb_converted"
}

# --- Home and /tmp -------------------------------------------------------

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$wb_state/migrate.log"; say "$*"; }

# Converted worktrees stay out of the copy: their work is in their Rift, and
# the old tree keeps them until `finish`.
home_excludes() {
    local p
    converted_paths | while IFS= read -r p; do
        [[ $p == "$wb_home"/* ]] && printf -- '--exclude=/%s/\n' "${p#"$wb_home"/}"
    done
}

# One rsync over the whole home: -H keeps the hard links bun makes from its
# cache into every node_modules, so a kept worktree costs no more than it does
# on ext4. ext4 has no reflinks to keep.
copy_pass() {
    local final=$1 home_dst=$2 tmp_dst=$3 excludes
    mapfile -t excludes < <(home_excludes)
    log "Copying $wb_home${final:+ (final pass)}"
    rsync "${rsync_flags[@]}" --delete "${excludes[@]}" "$wb_home/" "$home_dst/"
    log "Copying $wb_tmp${final:+ (final pass)}"
    rsync "${rsync_flags[@]}" --delete "${tmp_excludes[@]}" "$wb_tmp/" "$tmp_dst/"
}

verify_copy() {
    local home_dst=$1 tmp_dst=$2 excludes diff
    mapfile -t excludes < <(home_excludes)
    diff=$(rsync "${rsync_flags[@]}" --dry-run --delete --itemize-changes "${excludes[@]}" "$wb_home/" "$home_dst/" | grep -v '^\.d[^ ]* \./$' || true)
    diff+=$(rsync "${rsync_flags[@]}" --dry-run --delete --itemize-changes "${tmp_excludes[@]}" "$wb_tmp/" "$tmp_dst/" | grep -v '^\.d[^ ]* \./$' || true)
    if [[ -n $diff ]]; then
        head -40 <<< "$diff" >&2
        die "the copy differs from the source (above); nothing was moved"
    fi
}

# Units with a process of the home's owner, outside its sessions.
owner_units() {
    ps -u "$WB_USER" -o unit= 2>/dev/null | sort -u | grep -v -e '^session-' -e '^-$' -e '^user@' || true
}

stop_owner() {
    local uid unit
    uid=$(id -u "$WB_USER")
    : > "$wb_state/stopped"
    for unit in $(owner_units); do
        systemctl stop "$unit" && printf '%s\n' "$unit" >> "$wb_state/stopped"
    done
    systemctl stop "user@$uid.service" && printf 'user@%s.service\n' "$uid" >> "$wb_state/stopped"
    log "Stopped: $(tr '\n' ' ' < "$wb_state/stopped")"
    # Ends ssh and mosh sessions, which hold the home as their directory.
    loginctl terminate-user "$WB_USER" || true
}

start_owner() {
    [[ -s $wb_state/stopped ]] || return 0
    local unit
    # The user manager first: it starts the owner's own services.
    for unit in $(grep '^user@' "$wb_state/stopped"; grep -v '^user@' "$wb_state/stopped"); do
        systemctl start "$unit" 2>/dev/null || warn "did not start $unit (a scope starts again with its owner)"
    done
    : > "$wb_state/stopped"
}

# Holders that block the swap: anything under the home, and the owner's
# processes in /tmp. Another user's open file in /tmp keeps its inode.
blockers() {
    holders "$wb_home"
    holders "$wb_tmp" | while IFS=$'\t' read -r pid cmd name; do
        [[ $(ps -o user= -p "$pid" 2>/dev/null) == "$WB_USER" ]] && printf '%s\t%s\t%s\n' "$pid" "$cmd" "$name"
    done
}

wait_idle() {
    local busy
    for _ in $(seq 1 "${WB_IDLE_WAIT:-60}"); do
        busy=$(blockers)
        [[ -z $busy ]] && return 0
        sleep 1
    done
    printf '%s\n' "$busy" | awk -F '\t' '{ print "  " $2 " (pid " $1 "): " $3 }' | sort -u | head -40 >&2
    return 1
}

subvol_path() { printf '%s/%s' "$wb_workspaces" "$1"; }

home_phase() {
    local stop=$1 uuid stamp line sv
    [[ $(id -u) == 0 ]] || die 'run home as root'
    [[ $stop == false || -z $WB_ROOT ]] || die '--stop works only on the real root'
    is_btrfs_mount "$wb_workspaces" || die "$wb_workspaces is not a mounted btrfs"
    [[ $(mount_subvol "$wb_workspaces") == / ]] || die "$wb_workspaces must mount the image's top level"
    mkdir -p "$wb_state"
    if [[ $(mount_subvol "$wb_home") == /@home ]]; then
        say "$wb_home is already @home; run check.sh, then migrate.sh finish"
        return 0
    fi
    [[ ! -e $wb_old_home ]] || die "$wb_old_home exists but $wb_home is not @home; inspect both"
    [[ $(mount_subvol "$wb_tmp") != /@tmp ]] || die "$wb_tmp is already @tmp but $wb_home is not @home; inspect"

    # A record of each worktree's fate; classify reads git as the owner.
    as_user bash "$here/migrate.sh" classify > "$wb_state/worktrees.tsv"
    log "Worktrees kept as they are: $(awk -F '\t' '$1 == "keep"' "$wb_state/worktrees.tsv" | wc -l); converted: $(converted_paths | wc -l)"

    local need home_kb tmp_kb btrfs_free
    home_kb=$(du -sxk "$wb_home" | cut -f1)
    tmp_kb=$(du -sxk "$wb_tmp" | cut -f1)
    need=$(((home_kb + tmp_kb) * 1024))
    btrfs_free=$(btrfs filesystem usage -b "$wb_workspaces" 2>/dev/null | awk '/Free \(estimated\)/ { print $3; exit }')
    log "Copy needs at most $(gib "$need"); btrfs has $(gib "$btrfs_free") free, ext4 $(gib "$(ext4_free)")"
    ((need < btrfs_free)) || die 'not enough room in the image: run grow.sh first'
    ((need + WB_HEADROOM_GIB * 1073741824 < $(ext4_free))) || die 'ext4 cannot hold the copy and the headroom: free space or grow the disk'

    for sv in @home @tmp; do
        [[ -d $(subvol_path $sv) ]] || btrfs subvolume create "$(subvol_path $sv)" >/dev/null
    done
    chown --reference="$wb_home" "$(subvol_path @home)"
    chmod --reference="$wb_home" "$(subvol_path @home)"
    chown root:root "$(subvol_path @tmp)"
    chmod 1777 "$(subvol_path @tmp)"

    copy_pass '' "$(subvol_path @home)" "$(subvol_path @tmp)"

    if $stop; then
        stop_owner
        trap 'start_owner' EXIT
    fi
    log "Waiting for $wb_home and $wb_tmp to be idle"
    wait_idle || die "these processes still use $wb_home or $wb_tmp; stop them and rerun (the copy resumes)"
    copy_pass final "$(subvol_path @home)" "$(subvol_path @tmp)"
    verify_copy "$(subvol_path @home)" "$(subvol_path @tmp)"

    uuid=$(image_uuid)
    stamp=$(date -u +%Y%m%d%H%M%S)
    cp -p "$wb_fstab" "$wb_fstab.workbox-btrfs.$stamp"
    for sv in $wb_subvols; do
        line=$(fstab_line "$uuid" "${sv%%:*}" "${sv#*:}")
        grep -Fqx -e "$line" "$wb_fstab" || printf '%s\n' "$line" >> "$wb_fstab"
    done
    [[ -n $WB_ROOT ]] || systemctl daemon-reload

    log "Swapping $wb_home for @home"
    mv "$wb_home" "$wb_old_home"
    mkdir "$wb_home"
    chown --reference="$wb_old_home" "$wb_home"
    chmod --reference="$wb_old_home" "$wb_home"
    mount -T "$wb_fstab" "$wb_home"
    # The old /tmp stays under the mount until `finish` clears it.
    log "Mounting @tmp over $wb_tmp"
    mount -T "$wb_fstab" "$wb_tmp"

    if $stop; then
        trap - EXIT
        start_owner
    fi
    log 'Swapped. Checking'
    bash "$here/check.sh" || die 'check.sh failed after the swap; see RUNBOOK.md, Rollback'
    log "Done. When everything works, run: sudo $here/migrate.sh finish"
}

finish_phase() {
    local yes=$1 main bind
    [[ $(id -u) == 0 ]] || die 'run finish as root'
    bash "$here/check.sh" || die 'check.sh fails; fix that first (RUNBOOK.md, Rollback)'
    # Entries of converted worktrees, and stale ones such as /tmp/opencode/*-base.
    for main in "$wb_home"/Developer/*/*/.git; do
        [[ -d $main ]] || continue
        as_user git -C "${main%/.git}" worktree prune -v
    done
    if [[ -f $wb_converted ]]; then
        while IFS=$'\t' read -r _ _ t _ _; do
            [[ -d $wb_old_home/${t#"$wb_home"/} ]] || continue
            local common
            common=$(git -C "$wb_old_home/${t#"$wb_home"/}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || continue
            [[ $common == "$wb_home"/* ]] || as_user git --git-dir="$common" worktree prune -v
        done < "$wb_converted"
    fi
    $yes || { say "Would delete $wb_old_home and the old $wb_tmp under the mount; rerun with --yes"; return 0; }
    if [[ -d $wb_old_home ]]; then
        log "Deleting $wb_old_home"
        rm -rf --one-file-system "$wb_old_home"
    fi
    # The old /tmp is hidden under @tmp; reach it through a bind of the root.
    bind=$wb_state/root
    mkdir -p "$bind"
    mount --bind "$wb_root" "$bind"
    if [[ $(findmnt -n -o FSTYPE --target "$bind/tmp") == ext4 && $(stat -c %d "$bind/tmp") != $(stat -c %d "$wb_tmp") ]]; then
        log "Clearing the old $wb_tmp on ext4"
        find "$bind/tmp" -mindepth 1 -maxdepth 1 -exec rm -rf --one-file-system {} +
    fi
    umount "$bind"
    rmdir "$bind"
    bash "$here/grow.sh"
}

# home and finish move or delete the tree this script lives in: run a copy.
relocate() {
    [[ ${WB_RELOCATED:-} == 1 ]] && return 0
    local bin=$wb_state/bin
    mkdir -p "$bin"
    cp "$here"/*.sh "$bin/"
    cp "$conf" "$bin/worktrees.conf"
    if [[ $1 == home && ${2:-} == --stop && -z ${INVOCATION_ID:-} ]]; then
        # Stopping the owner ends this session too, so run in a unit of its own.
        systemd-run --unit=workbox-btrfs-migrate --collect --property=Type=exec \
            --setenv=WB_RELOCATED=1 --setenv=WB_USER="$WB_USER" --setenv=WB_DISK="$WB_DISK" \
            --setenv=WB_HEADROOM_GIB="$WB_HEADROOM_GIB" --setenv=WB_WORKTREES_CONF="$bin/worktrees.conf" \
            bash "$bin/migrate.sh" "$@"
        say "Running as workbox-btrfs-migrate. Your session ends when it stops your services."
        say "Follow it: journalctl -u workbox-btrfs-migrate -f, or $wb_state/migrate.log"
        exit 0
    fi
    WB_RELOCATED=1 WB_WORKTREES_CONF=$bin/worktrees.conf exec bash "$bin/migrate.sh" "$@"
}

case ${1:-} in
    plan) plan ;;
    classify) classify ;;
    convert) convert ;;
    home)
        [[ $(id -u) == 0 ]] || die 'run home as root (sudo)'
        relocate "$@"
        cd /
        home_phase "$([[ ${2:-} == --stop ]] && echo true || echo false)"
        ;;
    finish)
        [[ $(id -u) == 0 ]] || die 'run finish as root (sudo)'
        relocate "$@"
        cd /
        finish_phase "$([[ ${2:-} == --yes ]] && echo true || echo false)"
        ;;
    *) die 'usage: migrate.sh plan | convert | home [--stop] | finish [--yes]' ;;
esac
