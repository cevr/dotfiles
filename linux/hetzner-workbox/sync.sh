#!/usr/bin/env bash
# Copies the exe workbox to the Hetzner box over Tailscale. Run on the exe box,
# as root (sudo), from a terminal that outlives your ssh session (hc, tmux).
#
#   sync.sh [--dry-run] pass N    btrfs send of every subvolume under
#                                 HB_SYNC_SUBVOLS: pass 1 while everything runs,
#                                 pass 2 during the pause (only what changed
#                                 since pass 1), 3 and on if needed
#   sync.sh [--dry-run] rest      rsync -aHAX of HB_RSYNC_PATHS (outside the
#                                 subvolumes: MongoDB, Redis, /usr/local, the
#                                 crontab, the Tailscale sshd host key)
#   sync.sh [--dry-run] runs [--yes]
#                                 the durable run areas (HB_RUNS_FROM: the Bite
#                                 run's /tmp/vperf2) to /runs/<name> on the target:
#                                 measures the bytes and the cost and copies only
#                                 with --yes (the owner's, at that step of the
#                                 move), then compares every file's checksum; the
#                                 source is never changed
#   sync.sh activate N            on the target: puts pass N in place as @home
#                                 and @workspaces (the old ones are kept aside);
#                                 the target then reboots
#   sync.sh remote ...            the target's side; sync.sh ships itself there
#
# --dry-run prints the GB each step would move (exe bills TX over 200 GB a
# month at $0.05/GB); a pass uses and removes transient local snapshots.
#
# Each subvolume (the home, /workspaces, every warm source and Rift inside it)
# is sent on its own: btrfs send does not descend into nested subvolumes. A
# Rift is sent with its warm source as the parent (-p), so the target gets a
# snapshot of the source plus the Rift's own changes and the two share their
# extents as they do here. Pass N > 1 sends each subvolume against its pass
# N-1 snapshot. The read-only snapshots live in HB_SNAPDIR, a root-only
# directory on the same btrfs, and in .hetzner-sync on the target's top level,
# which is mounted only while sync.sh runs there.
#
# Env:
#   HB_TO            ssh destination (exedev@<new box's Tailscale IP>); "local"
#                    runs the target side on this host (test.sh)
#   WORKBOX_EXPECT_MACHINE_ID  independently recorded local machine-id
#   HB_TARGET_MACHINE_ID      independently recorded destination machine-id (remote only)
#   HB_SSH_PORT      2222       HB_SSH_KEY  /home/exedev/.ssh/hetzner-sync
#   HB_SYNC_SUBVOLS  "@home:/home/exedev @workspaces:/workspaces" (name:mount
#                    point; /tmp is emptied at boot, so @tmp is not copied)
#   HB_SNAPDIR       /tmp/.hetzner-sync (must be on the same btrfs)
#   HB_RSYNC_PATHS   see below
#   HB_RUNS_FROM     /tmp/vperf2 (directories, space-separated)
#   HB_RUNS_TO       /runs (the target's durable area, @runs)
#   HB_RUNS_INCLUDE  a file of subpaths (relative to each HB_RUNS_FROM directory)
#                    to copy instead of all of it; unset: all
#   HB_TARGET_ANCHOR a path on the target's btrfs (default /workspaces)
#   HB_TARGET_PREFIX prefix of the rsync destination (test.sh only)
set -euo pipefail

self=$(readlink -f "$0")
remote_dir=/var/lib/hetzner-sync
identity=${self%/*}/host-identity.sh
[[ -r $identity ]] || identity=${self%/*}/../../workbox/host-identity.sh
# shellcheck source=../../workbox/host-identity.sh
. "$identity"
workbox_require_host
HB_TO=${HB_TO:-}
HB_SSH_PORT=${HB_SSH_PORT:-2222}
HB_SSH_KEY=${HB_SSH_KEY:-/home/exedev/.ssh/hetzner-sync}
HB_SYNC_SUBVOLS=${HB_SYNC_SUBVOLS:-"@home:/home/exedev @workspaces:/workspaces"}
HB_SNAPDIR=${HB_SNAPDIR:-/tmp/.hetzner-sync}
HB_RSYNC_PATHS=${HB_RSYNC_PATHS:-"/var/lib/mongodb /var/lib/redis /usr/local /var/spool/cron/crontabs/exedev \
/etc/ssh/bite-workbox-ssh-host-ed25519-key /etc/ssh/bite-workbox-ssh-host-ed25519-key.pub"}
HB_TARGET_ANCHOR=${HB_TARGET_ANCHOR:-/workspaces}
HB_TARGET_PREFIX=${HB_TARGET_PREFIX:-}
HB_RUNS_FROM=${HB_RUNS_FROM:-/tmp/vperf2}
HB_RUNS_TO=${HB_RUNS_TO:-/runs}
HB_RUNS_INCLUDE=${HB_RUNS_INCLUDE:-}
# Dollars per GB of exe's TX past its 200 GB.
tx_price=0.05

say() { printf '==> %s\n' "$*" >&2; }
die() { printf 'sync.sh: %s\n' "$*" >&2; exit 1; }
gb() { awk -v b="$1" 'BEGIN { printf "%.2f GB", b / 1e9 }'; }
safe() { local a; for a; do [[ $a =~ ^[A-Za-z0-9@._/:+-]+$ ]] || die "unsafe argument: $a"; done; }
mount_source() { findmnt -n -o SOURCE -T "$1" | sed 's/\[.*//'; }
fsroot() { findmnt -n -o FSROOT --mountpoint "$1"; }
fs_uuid() { findmnt -n -o UUID -T "$1"; }
# A complete received subvolume has a Received UUID.
received() { [[ -d $1 ]] && btrfs subvolume show "$1" 2>/dev/null | awk '/Received UUID:/ { r = $3 } END { exit !(r != "" && r != "-") }'; }

[[ $(id -u) == 0 ]] || die "run as root"

# ---------------------------------------------------------------- target side
remote_top=$remote_dir/top
remote_main() {
    local anchor=$1 action=$2
    shift 2
    safe "$anchor" "$action" "$@"
    local dev
    dev=$(mount_source "$anchor")
    [[ $(findmnt -n -o FSTYPE -T "$anchor") == btrfs ]] || die "target $anchor is not btrfs"
    install -d -m 700 "$remote_dir" "$remote_top"
    # The top level, for root, while this runs.
    mountpoint -q "$remote_top" || mount -o subvolid=5,noatime "$dev" "$remote_top"
    local base=$remote_top/.hetzner-sync
    [[ -d $base ]] || btrfs subvolume create "$base" >/dev/null
    case $action in
    have) # N: the completed subvolumes of pass N
        local d
        for d in "$base/$1"/*; do received "$d" && basename "$d"; done
        true ;;
    recv) # N uuid, stream on stdin
        install -d "$base/$1"
        if [[ -d $base/$1/$2 ]] && ! received "$base/$1/$2"; then
            btrfs property set "$base/$1/$2" ro false
            btrfs subvolume delete "$base/$1/$2" >/dev/null
        fi
        btrfs receive -q "$base/$1" ;;
    manifest) # N, the manifest on stdin
        install -d "$base/$1"
        cat > "$base/$1.manifest" ;;
    activate) remote_activate "$base" "$1" ;;
    umount) umount "$remote_top" ;;
    *) die "unknown remote action: $action" ;;
    esac
}

remote_activate() {
    local base=$1 n=$2 manifest=$1/$2.manifest uuid rel ro name rest dest stamp
    [[ -f $manifest ]] || die "no manifest for pass $n: run pass $n first"
    # Every listed subvolume must have arrived.
    while IFS=$'\t' read -r uuid rel ro; do
        received "$base/$n/$uuid" || die "pass $n is incomplete: $rel ($uuid) did not arrive; rerun pass $n"
    done < "$manifest"
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    install -d "$base/old-$stamp"
    # Anchors first, then nested subvolumes by depth: a parent's snapshot holds
    # an empty directory where each child goes.
    awk -F'\t' '{ s = $2; print gsub("/", "/", s) "\t" $0 }' "$manifest" | sort -n -k1,1 | cut -f2- |
    while IFS=$'\t' read -r uuid rel ro; do
        name=${rel%%/*}
        rest=${rel#"$name"}
        dest=$remote_top/$name.hetzner-new$rest
        if [[ -z $rest ]]; then
            [[ ! -e $dest ]] || mv "$dest" "$base/old-$stamp/$name.hetzner-new"
        else
            if [[ -d $dest ]]; then rmdir "$dest" 2>/dev/null || true; fi
            [[ ! -e $dest ]] || die "$dest is in the way (not an empty directory)"
            install -d "$(dirname "$dest")"
        fi
        btrfs subvolume snapshot "$base/$n/$uuid" "$dest" >/dev/null
        [[ $ro == 1 ]] && btrfs property set "$dest" ro true
        printf '%s\n' "$rel"
    done > "$base/$n.activated"
    while IFS=$'\t' read -r uuid rel ro; do
        [[ $rel == */* ]] && continue
        [[ ! -e $remote_top/$rel ]] || mv "$remote_top/$rel" "$base/old-$stamp/$rel"
        mv "$remote_top/$rel.hetzner-new" "$remote_top/$rel"
        say "activated $rel from pass $n (the old one is in .hetzner-sync/old-$stamp)"
    done < "$manifest"
    say "$(wc -l < "$base/$n.activated") subvolumes in place; reboot (or remount them) to use them"
}

if [[ ${1:-} == remote ]]; then
    shift
    remote_main "$@"
    exit
fi

# ---------------------------------------------------------------- source side
dry=0
if [[ ${1:-} == --dry-run ]]; then dry=1; shift; fi
cmd=${1:-}
[[ -n $cmd ]] || die "usage: sync.sh [--dry-run] pass N | rest | runs [--yes] | activate N"

ssh_cmd=(ssh -p "$HB_SSH_PORT" -o BatchMode=yes -o ServerAliveInterval=30
    -o StrictHostKeyChecking=yes -o UpdateHostKeys=no -o UserKnownHostsFile=/root/.ssh/hetzner-sync-known_hosts)
[[ -f $HB_SSH_KEY ]] && ssh_cmd+=(-i "$HB_SSH_KEY" -o IdentitiesOnly=yes)
remote_script=$remote_dir/sync.sh
target_test=
if [[ -n $HB_TO && $HB_TO != local ]]; then
    [[ ${HB_TARGET_MACHINE_ID:-} =~ ^[a-f0-9]{32}$ ]] ||
        { printf 'sync.sh: intended-host identity refused: set HB_TARGET_MACHINE_ID\n' >&2; exit 78; }
    target_test="test \"\$(cat /etc/machine-id)\" = $HB_TARGET_MACHINE_ID"
    # This check precedes local snapshot writes and any remote privileged command.
    [[ $("${ssh_cmd[@]}" "$HB_TO" cat /etc/machine-id) == "$HB_TARGET_MACHINE_ID" ]] ||
        { printf 'sync.sh: intended-host identity refused: SSH peer does not match HB_TARGET_MACHINE_ID\n' >&2; exit 78; }
fi
remote() {
    safe "$HB_TARGET_ANCHOR" "$@"
    if [[ $HB_TO == local ]]; then
        bash "$self" remote "$HB_TARGET_ANCHOR" "$@"
    else
        "${ssh_cmd[@]}" "$HB_TO" "$target_test && sudo -n env WORKBOX_EXPECT_MACHINE_ID=$HB_TARGET_MACHINE_ID" \
            bash "$remote_script" remote "$HB_TARGET_ANCHOR" "$@"
    fi
}
ship() {
    [[ $HB_TO == local ]] && return
    "${ssh_cmd[@]}" "$HB_TO" "$target_test && sudo -n install -d -m 700 $remote_dir && sudo -n tee $remote_dir/host-identity.sh >/dev/null" < "$identity"
    "${ssh_cmd[@]}" "$HB_TO" "$target_test && sudo -n tee $remote_script >/dev/null" < "$self"
}

# Prints "uuid<TAB>parent uuid<TAB>path from the top level<TAB>ro" for every
# subvolume to copy, the anchors first.
list_subvols() {
    local pair name mp fsr ro_ids
    local snap_rel
    snap_rel=$(fsroot "$(findmnt -n -o TARGET -T "$HB_SNAPDIR")")${HB_SNAPDIR#"$(findmnt -n -o TARGET -T "$HB_SNAPDIR")"}
    snap_rel=${snap_rel#/}
    for pair in $HB_SYNC_SUBVOLS; do
        name=${pair%%:*}
        mp=${pair#*:}
        fsr=$(fsroot "$mp")
        [[ $fsr == "/$name" ]] || die "$mp is not the subvolume $name (it mounts ${fsr:-nothing})"
        ro_ids=" $(btrfs subvolume list -a -r "$mp" | awk '{ printf "%s ", $2 }')"
        btrfs subvolume list -a -u -q "$mp" | awk -v name="$name" -v ro="$ro_ids" -v snap="$snap_rel" '
            {
                for (i = 1; i < NF; i++) {
                    if ($i == "parent_uuid") pu = $(i + 1)
                    if ($i == "uuid") u = $(i + 1)
                    if ($i == "path") { p = $(i + 1); for (j = i + 2; j <= NF; j++) p = p " " $j }
                }
                sub(/^<FS_TREE>\//, "", p)
                if (p != name && index(p, name "/") != 1) next
                if (snap != "" && (p == snap || index(p, snap "/") == 1)) next
                if (p ~ /[ \t]/) { print "skipping a subvolume with a space in its path: " p > "/dev/stderr"; next }
                print u "\t" pu "\t" p "\t" (index(ro, " " $2 " ") ? 1 : 0)
            }' | sort -t $'\t' -k3,3
    done
}
live_path() { # path from the top level -> path here
    local rel=$1 pair name
    for pair in $HB_SYNC_SUBVOLS; do
        name=${pair%%:*}
        [[ $rel == "$name" || $rel == "$name"/* ]] && { echo "${pair#*:}${rel#"$name"}"; return; }
    done
    die "no mount for $rel"
}

# The caches (storage.conf's cache lines) as paths here: they are left out of the copy (the target
# makes each an empty limited subvolume, and the tools fill it again). ~ is @home's mount point here,
# /workspaces @workspaces'.
HB_STORAGE_CONF=${HB_STORAGE_CONF:-$(dirname "$self")/storage.conf}
cache_paths() {
    local kind path rest pair home='' ws=''
    for pair in $HB_SYNC_SUBVOLS; do
        case ${pair%%:*} in @home) home=${pair#*:} ;; @workspaces) ws=${pair#*:} ;; esac
    done
    [[ -f $HB_STORAGE_CONF ]] || return 0
    while read -r kind path rest; do
        [[ $kind == cache ]] || continue
        case $path in
        "~" | "~"/*) [[ -n $home ]] && echo "$home${path#"~"}" ;;
        /workspaces | /workspaces/*) [[ -n $ws ]] && echo "$ws${path#/workspaces}" ;;
        esac
    done < <(sed -e 's/#.*//' "$HB_STORAGE_CONF" | grep .)
    return 0
}
under() { [[ $1 == "$2" || $1 == "$2"/* ]]; } # path dir

# A read-only snapshot of the live subvolume $1 at $2 without the caches inside it: a writable
# snapshot, the caches' directories removed from it (only from this snapshot, which sync.sh made: the
# live caches stay), then read-only. A cache inside a nested subvolume goes with that one's snapshot.
snapshot_for_send() { # live dest
    local live=$1 dest=$2 c inside=()
    for c in "${caches[@]}"; do
        under "$c" "$live" && [[ $c != "$live" ]] && inside+=("${c#"$live"/}")
    done
    if ((${#inside[@]} == 0)); then
        btrfs subvolume snapshot -r "$live" "$dest" >/dev/null
        return
    fi
    btrfs subvolume snapshot "$live" "$dest" >/dev/null
    for c in "${inside[@]}"; do
        # Inside this snapshot's own tree only: a path through a nested subvolume is an empty
        # directory here and does not resolve.
        if [[ -d $dest/$c && $(stat -f -c %i "$dest/$c") == "$(stat -f -c %i "$dest")" ]]; then
            say "leaving out the cache $live/$c"
            rm -rf --one-file-system "${dest:?}/$c"
        fi
    done
    btrfs property set -ts "$dest" ro true
}

send_opts=()
if btrfs send --help 2>&1 | grep -q -- --compressed-data; then send_opts=(--proto 2 --compressed-data); fi

do_pass() {
    local n=$1 prev=$(($1 - 1)) dir list total=0 uuid pu rel ro snap parent bytes kind
    [[ $n =~ ^[1-9][0-9]*$ ]] || die "pass needs a number"
    install -d -m 700 "$HB_SNAPDIR"
    [[ $(findmnt -n -o FSTYPE -T "$HB_SNAPDIR") == btrfs ]] || die "$HB_SNAPDIR is not on btrfs"
    local first_mp=${HB_SYNC_SUBVOLS%% *}
    first_mp=${first_mp#*:}
    [[ $(fs_uuid "$HB_SNAPDIR") == "$(fs_uuid "$first_mp")" ]] || die "$HB_SNAPDIR is on another btrfs than $first_mp"
    dir=$HB_SNAPDIR/$n
    ((dry)) && dir=$HB_SNAPDIR/$n.dry
    install -d -m 700 "$dir"
    mapfile -t caches < <(cache_paths)
    list=$(list_subvols)
    # A cache that is a subvolume of its own (or inside one) is not sent at all.
    local kept='' line c skip
    while IFS= read -r line; do
        skip=0
        for c in "${caches[@]}"; do
            if under "$(live_path "$(cut -f3 <<<"$line")")" "$c"; then skip=1; say "leaving out the cache subvolume $c"; fi
        done
        ((skip)) || kept+=$line$'\n'
    done <<<"$list"
    list=${kept%$'\n'}
    [[ -n $list ]] || die "nothing to copy"
    printf '%s\n' "$list" | cut -f1,3,4 > "$dir.manifest"
    # What the target already holds, by pass.
    declare -A on_target=()
    if ((dry)); then
        # A dry run stays on this host: it takes the target to hold every
        # earlier pass this host holds.
        for uuid in $(printf '%s\n' "$list" | cut -f1); do
            if [[ -d $HB_SNAPDIR/$prev/$uuid ]]; then on_target[$prev/$uuid]=1; fi
        done
    elif [[ -n $HB_TO ]]; then
        ship
        for p in "$prev" "$n"; do
            ((p >= 1)) || continue
            while read -r uuid; do on_target[$p/$uuid]=1; done < <(remote have "$p")
        done
    else
        die "set HB_TO (exedev@<the new box's Tailscale IP>)"
    fi
    # Read-only snapshots of everything first, so one pass is one moment per subvolume.
    while IFS=$'\t' read -r uuid pu rel ro; do
        # A snapshot left writable (a pass cut short while it left the caches out) is made again.
        if [[ -d $dir/$uuid && $(btrfs property get -ts "$dir/$uuid" ro) == ro=false ]]; then
            btrfs subvolume delete "$dir/$uuid" >/dev/null
        fi
        [[ -d $dir/$uuid ]] || snapshot_for_send "$(live_path "$rel")" "$dir/$uuid"
    done <<<"$list"
    # Parents before children, so a Rift can be sent against its warm source.
    declare -A in_list=() done_=()
    while IFS=$'\t' read -r uuid pu rel ro; do in_list[$uuid]=1; done <<<"$list"
    local left=1 progress
    while ((left)); do
        left=0 progress=0
        while IFS=$'\t' read -r uuid pu rel ro; do
            [[ -n ${done_[$uuid]:-} ]] && continue
            if [[ $pu != - && -n ${in_list[$pu]:-} && -z ${done_[$pu]:-} ]]; then left=1; continue; fi
            snap=$dir/$uuid
            parent='' kind=full
            if [[ -n ${on_target[$prev/$uuid]:-} && -d $HB_SNAPDIR/$prev/$uuid ]]; then
                parent=$HB_SNAPDIR/$prev/$uuid kind="since pass $prev"
            elif [[ $pu != - && -n ${in_list[$pu]:-} ]] && { ((dry)) || [[ -n ${on_target[$n/$pu]:-} ]]; }; then
                parent=$dir/$pu kind="from its origin"
            elif [[ $pu != - && -n ${on_target[$prev/$pu]:-} && -d $HB_SNAPDIR/$prev/$pu ]]; then
                parent=$HB_SNAPDIR/$prev/$pu kind="from its origin's pass $prev"
            fi
            if ((dry)); then
                bytes=$(btrfs send -q --no-data ${parent:+-p "$parent"} "$snap" | btrfs receive --dump |
                    awk '$1 == "update_extent" { for (i = 2; i <= NF; i++) if ($i ~ /^len=/) s += substr($i, 5) } END { printf "%d", s }')
                total=$((total + bytes))
                printf '%-60s %-28s %s\n' "$rel" "$kind" "$(gb "$bytes")"
            elif [[ -n ${on_target[$n/$uuid]:-} ]]; then
                say "ok: $rel is there"
            else
                say "send $rel ($kind)"
                btrfs send -q "${send_opts[@]}" ${parent:+-p "$parent"} "$snap" | remote recv "$n" "$uuid"
                on_target[$n/$uuid]=1
            fi
            done_[$uuid]=1
            progress=1
        done <<<"$list"
        ((progress)) || die "parent loop among the subvolumes"
    done
    if ((dry)); then
        printf '%-60s %-28s %s\n' "btrfs total (data before compression)" "" "$(gb "$total")"
        printf 'At $%s/GB past exe'"'"'s 200 GB: $%s at most\n' "$tx_price" "$(awk -v b="$total" -v p="$tx_price" 'BEGIN { printf "%.2f", b / 1e9 * p }')"
        # The dry snapshots go; a real pass takes its own.
        while IFS=$'\t' read -r uuid pu rel ro; do btrfs subvolume delete "$dir/$uuid" >/dev/null; done <<<"$list"
        rmdir "$dir"
        rm -f "$dir.manifest"
        return
    fi
    remote manifest "$n" < "$dir.manifest"
    remote umount
    say "pass $n done: $(wc -l < "$dir.manifest") subvolumes"
}

do_rest() {
    local p dest=${HB_TO:-}
    local args=(-aHAX --relative --delete --info=stats1)
    local paths=()
    for p in $HB_RSYNC_PATHS; do
        if [[ -e $p ]]; then paths+=("$p"); else say "skip $p (absent here)"; fi
    done
    ((${#paths[@]})) || return 0
    if [[ $dest == local ]]; then
        [[ -n $HB_TARGET_PREFIX ]] || die "HB_TO=local needs HB_TARGET_PREFIX"
        install -d "$HB_TARGET_PREFIX"
        dest=$HB_TARGET_PREFIX/
    elif [[ -n $dest ]]; then
        args+=(-e "${ssh_cmd[*]}" --rsync-path="$target_test && sudo -n rsync")
        dest=$dest:$HB_TARGET_PREFIX/
    elif ((dry)); then
        local b
        b=$(du -scb "${paths[@]}" | tail -n 1 | cut -f1)
        printf '%-60s %-28s %s\n' "rest (${#paths[@]} paths)" "full, no target yet" "$(gb "$b")"
        return
    else
        die "set HB_TO"
    fi
    ((dry)) && args+=(--dry-run)
    say "rsync ${paths[*]}"
    rsync "${args[@]}" "${paths[@]}" "$dest" | awk '/^Total transferred file size/ { print "rest: " $0 } /^Total bytes sent/ { print "rest: " $0 }'
}

# The durable run areas: the owner's run records (the Bite run's /tmp/vperf2 on the exe box, which a
# boot would empty on the new box) go to /runs, @runs: limited, never cleaned, backed up. rsync, not
# btrfs send: on the exe box they are not a subvolume. The bytes are measured, not estimated (rsync's
# own count of what it would send: the apparent size of a copy-on-write disk says nothing), with their
# price; nothing is copied without --yes. After the copy every file is compared by checksum; the
# source is never changed or removed (it stays on the old box until that box is retired). Nothing is
# deleted on the target either (no --delete).
do_runs() {
    local yes=0 src name dest bytes args list=() diffs to
    [[ -z ${1:-} || $1 == --yes ]] || die "usage: sync.sh [--dry-run] runs [--yes]"
    [[ ${1:-} == --yes ]] && yes=1
    [[ -n $HB_TO ]] || die "set HB_TO"
    # Run records are not session stores. Never read or transfer one, even with an include list.
    args=(-aHAX --sparse --exclude=opencode.db --exclude='opencode.db-*')
    if [[ -n $HB_RUNS_INCLUDE ]]; then
        [[ -f $HB_RUNS_INCLUDE ]] || die "HB_RUNS_INCLUDE: no file $HB_RUNS_INCLUDE"
        if grep -Eq '(^|/)opencode\.db(-[^/]*)?(/|$)' "$HB_RUNS_INCLUDE"; then
            die "HB_RUNS_INCLUDE must not name OpenCode session-store files"
        fi
        # Only these subpaths; -r again, as --files-from turns -a's recursion off.
        args+=(-r --files-from="$HB_RUNS_INCLUDE")
    fi
    if [[ $HB_TO == local ]]; then
        [[ -n $HB_TARGET_PREFIX ]] || die "HB_TO=local needs HB_TARGET_PREFIX"
        to=$HB_TARGET_PREFIX$HB_RUNS_TO
        [[ -d $to ]] || die "$to is missing: the target's provision.sh storage phase makes it"
    else
        args+=(-e "${ssh_cmd[*]}" --rsync-path="$target_test && sudo -n rsync")
        to=$HB_TO:$HB_TARGET_PREFIX$HB_RUNS_TO
    fi
    for src in $HB_RUNS_FROM; do
        src=${src%/}
        [[ -d $src ]] || die "runs source $src is absent; nothing copied"
        list+=("$src")
    done
    ((${#list[@]})) || die "no runs sources; nothing copied"
    local total=0
    for src in "${list[@]}"; do
        name=${src##*/}
        dest=$to/$name/
        bytes=$(LC_ALL=C rsync "${args[@]}" --dry-run --stats "$src/" "$dest" | awk '/^Total transferred file size:/ { gsub(/[^0-9]/, "", $5); print $5 }')
        [[ $bytes =~ ^[0-9]+$ ]] || die "rsync measured nothing for $src"
        printf 'runs: %s -> %s: %s bytes (%s) to send\n' "$src" "$HB_RUNS_TO/$name" "$bytes" "$(gb "$bytes")"
        total=$((total + bytes))
    done
    printf 'runs: %s logical bytes (%s) in all; at $%s/GB past exe'"'"'s 200 GB: estimated $%s\n' "$total" "$(gb "$total")" "$tx_price" \
        "$(awk -v b="$total" -v p="$tx_price" 'BEGIN { printf "%.2f", b / 1e9 * p }')"
    if ((dry || !yes)); then
        echo "runs: nothing copied. Rerun with --yes to copy (the owner approves the bytes and the cost above)."
        return
    fi
    for src in "${list[@]}"; do
        name=${src##*/}
        dest=$to/$name/
        say "copying $src to $HB_RUNS_TO/$name"
        rsync "${args[@]}" "$src/" "$dest"
        # Compare source-selected files and their metadata; a failed comparison is not a match.
        diffs=$(rsync "${args[@]}" --checksum --dry-run --itemize-changes "$src/" "$dest") ||
            die "runs: could not verify $HB_RUNS_TO/$name"
        if [[ -n $diffs ]]; then
            printf '%s\n' "$diffs" | sed -n '1,20p' >&2
            die "runs: $HB_RUNS_TO/$name differs from $src ($(printf '%s\n' "$diffs" | wc -l) paths): copy again before relying on it"
        fi
        echo "runs: verified $HB_RUNS_TO/$name: every file's checksum equals $src's. $src stays on this box until it is retired."
    done
}

case $cmd in
pass) do_pass "${2:-}" ;;
rest) do_rest ;;
runs) [[ $# -le 2 ]] || die "usage: sync.sh [--dry-run] runs [--yes]"; do_runs "${2:-}" ;;
activate)
    ((dry)) && die "activate has no dry run"
    [[ ${2:-} =~ ^[1-9][0-9]*$ ]] || die "activate needs a pass number"
    [[ -n $HB_TO ]] || die "set HB_TO"
    ship
    remote activate "$2"
    remote umount ;;
*) die "unknown command: $cmd" ;;
esac
