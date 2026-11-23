#!/usr/bin/env bash
# The Hetzner box's limited subvolumes (storage.conf), with btrfs simple quotas (squota). As root.
#
#   storage.sh enable   turns simple quotas on for the btrfs (layout.sh, the first boot: before
#                       anything but the OS is written, so every later byte is counted); refuses a
#                       file system that has full qgroups on
#   storage.sh apply    each storage.conf line: the subvolume (made if missing, or in place of an empty
#                       directory), its owner and mode, its limit, its qgroup; prints ok or what changed.
#                       provision.sh's storage phase, and hetzner-workbox-storage.service at each boot
#                       (the boot empties /tmp, so /tmp/opencode is made again there, with its limit)
#   storage.sh check    changes nothing; fails, naming each line apply would change (check.sh)
#
# It deletes nothing: a directory that holds files where a subvolume belongs is named and left.
# Simple quotas count each extent to the subvolume that wrote it (README.md, "Layout"); a snapshot's
# own figure is what it wrote since it was taken. Each subvolume's figures are world-readable in
# /sys/fs/btrfs/<fs uuid>/qgroups/0_<subvolume id>/{referenced,exclusive,max_referenced}.
#
# Env (test.sh): HB_TARGET, HB_HOME, HB_WORKSPACES, HB_RUNS, HB_USER (common.sh); HB_STORAGE_CONF.
set -euo pipefail
# shellcheck source=common.sh
. "$(dirname "$0")/common.sh"
[[ ${1:-} == check ]] || hb_require_host
HB_STORAGE_CONF=${HB_STORAGE_CONF:-$hb_dir/storage.conf}
sysfs=/sys/fs/btrfs

ok() { printf 'ok: %s\n' "$*"; }
dry=0
changed=0
# Runs a change (or, in check, names it): "act <what it does> -- <command>...".
act() {
    local what=$1
    shift 2
    changed=1
    if ((dry)); then
        printf 'storage: would %s\n' "$what" >&2
    else
        "$@"
        say "$what"
    fi
}
problems=0
problem() { problems=1; printf 'storage: %s\n' "$*" >&2; }

# A storage.conf path as it is on this host: ~ is the user's home; /workspaces and the rest are under
# their HB_* roots (scratch mounts in test.sh).
box_path() {
    case $1 in
    "~" | "~"/*) echo "$HB_HOME${1#"~"}" ;;
    /workspaces | /workspaces/*) echo "$HB_WORKSPACES${1#/workspaces}" ;;
    /runs | /runs/*) echo "$HB_RUNS${1#/runs}" ;;
    *) echo "$HB_TARGET$1" ;;
    esac
}
bytes() { # 150G -> bytes (binary units, as btrfs reads them)
    local n=${1%[KMGT]}
    case ${1: -1} in K) echo $((n << 10)) ;; M) echo $((n << 20)) ;; G) echo $((n << 30)) ;; T) echo $((n << 40)) ;; *) echo "$1" ;; esac
}
owner_of() { if [[ $1 == user ]]; then echo "$HB_USER"; else echo root; fi; }
fs_uuid() { findmnt -n -o UUID -T "$1"; }
qgroups() { echo "$sysfs/$(fs_uuid "$1")/qgroups"; }
quota_mode() { cat "$(qgroups "$1")/mode" 2>/dev/null || echo off; }
on_btrfs() { [[ $(stat -f -c %T "$1" 2>/dev/null) == btrfs ]]; }
is_subvolume() { [[ -d $1 ]] && on_btrfs "$1" && [[ $(stat -c %i "$1") == 256 ]]; }
anchor=$HB_WORKSPACES

# The conf's lines without comments: "kind path limit owner mode group" or "qgroup name id limit".
conf_lines() { sed -e 's/#.*//' -e 's/[[:space:]]*$//' "$HB_STORAGE_CONF" | grep .; }

do_enable() {
    on_btrfs "$anchor" || die "$anchor is not on btrfs"
    local mode
    mode=$(quota_mode "$anchor")
    case $mode in
    squota) ok "simple quotas are on ($(fs_uuid "$anchor"))" ;;
    off)
        btrfs quota enable --simple "$anchor" ||
            die "btrfs quota enable --simple failed (it needs btrfs-progs 6.7 and kernel 6.7 or later: system-tools.sh btrfs)"
        [[ $(quota_mode "$anchor") == squota ]] || die "quotas are $(quota_mode "$anchor") after enable --simple"
        say "simple quotas on for $(fs_uuid "$anchor")" ;;
    *) die "this btrfs has full qgroups on ($mode); simple quotas are not put over them (btrfs quota disable first, on purpose)" ;;
    esac
}

# The subvolume for one line, made or found. Returns 1 when the rest of the line cannot be checked:
# a directory holding files (named, left) or, in check, a subvolume not made yet.
ensure_subvolume() { # path owner
    local p=$1 owner=$2 parent
    is_subvolume "$p" && return 0
    if [[ -e $p && ! -d $p ]]; then
        problem "$p is not a directory: left as it is"
        return 1
    fi
    if [[ -d $p && -n $(ls -A "$p") ]]; then
        problem "$p holds files and is not a subvolume: left as it is (it gets its subvolume once it is empty or gone)"
        return 1
    fi
    # Its missing parents are made as the owner, each of them, as the tool would have made them.
    local missing=() d
    parent=$(dirname "$p")
    for ((d = 0; d < 64; d++)); do
        [[ -d $parent ]] && break
        missing=("$parent" "${missing[@]}")
        parent=$(dirname "$parent")
    done
    for d in "${missing[@]}"; do
        act "make $d" -- install -d -o "$owner" -g "$(id -gn "$owner")" "$d"
    done
    [[ -d $p ]] && act "remove the empty directory $p" -- rmdir "$p"
    act "make subvolume $p" -- btrfs -q subvolume create "$p"
    ((dry)) && return 1
    return 0
}

# The higher-level qgroups subvolume 0/$2 belongs to ("1/100" each), from qgroup show's Parent column.
qgroup_parents() {
    btrfs qgroup show -p --raw "$1" | awk -v q="0/$2" '
        NR == 1 { for (i = 1; i <= NF; i++) if ($i == "Parent") col = i; next }
        $1 == q && col { n = split($col, a, ","); for (i = 1; i <= n; i++) if (a[i] ~ /\//) print a[i] }'
}

declare -A group_ids=()
apply_line() { # kind path limit owner mode group
    local kind=$1 path=$2 limit=$3 owner mode=$5 group=$6 p id q gid
    owner=$(owner_of "$4")
    p=$(box_path "$path")
    case $kind in scratch | cache | durable) ;; *) die "storage.conf: unknown kind $kind for $path" ;; esac
    ensure_subvolume "$p" "$owner" || return 0
    [[ $(stat -c %U "$p") == "$owner" ]] || act "owner $owner: $p" -- chown "$owner:$(id -gn "$owner")" "$p"
    [[ $mode == - || $(stat -c %a "$p") == "${mode#0}" ]] || act "mode $mode: $p" -- chmod "$mode" "$p"
    id=$(btrfs inspect-internal rootid "$p")
    q=$(qgroups "$p")/0_$id
    [[ -d $q ]] || die "no qgroup 0/$id for $p: are simple quotas on? (storage.sh enable)"
    [[ $(cat "$q/max_referenced") == "$(bytes "$limit")" ]] || act "limit $limit: $p" -- btrfs qgroup limit "$limit" "$p"
    if [[ $group != - ]]; then
        gid=${group_ids[$group]:-}
        [[ -n $gid ]] || die "storage.conf: no qgroup line names $group"
        qgroup_parents "$p" "$id" | grep -qx "$gid" ||
            act "join qgroup $gid ($group): $p" -- btrfs qgroup assign --no-rescan "0/$id" "$gid" "$p"
    fi
    ((dry)) || ok "$kind $path: subvolume 0/$id, limit $limit${group/#-/}"
}

apply_group() { # name id limit
    local q
    q=$(qgroups "$anchor")/${2/\//_}
    group_ids[$1]=$2
    if [[ ! -d $q ]]; then
        act "make qgroup $2 ($1)" -- btrfs qgroup create "$2" "$anchor"
        ((dry)) && return 0
    fi
    [[ $(cat "$q/max_referenced") == "$(bytes "$3")" ]] || act "limit $3: qgroup $2 ($1)" -- btrfs qgroup limit "$3" "$2" "$anchor"
    ((dry)) || ok "qgroup $1 $2, limit $3"
}

do_apply() {
    need_root
    [[ $(quota_mode "$anchor") == squota ]] || die "simple quotas are not on for $anchor: storage.sh enable (layout.sh runs it)"
    local kind rest
    # The groups first: a member joins one that exists.
    while read -r kind rest; do
        # shellcheck disable=SC2086 # the line's words
        if [[ $kind == qgroup ]]; then apply_group $rest; fi
    done < <(conf_lines)
    while read -r kind rest; do
        # shellcheck disable=SC2086 # the line's words
        if [[ $kind != qgroup ]]; then apply_line "$kind" $rest; fi
    done < <(conf_lines)
}

case ${1:-} in
enable) need_root; do_enable ;;
apply) do_apply; ((problems == 0)) || exit 1 ;;
check)
    dry=1
    do_apply
    ((changed == 0 && problems == 0)) || die "storage.conf is not in place (above)"
    ok "storage.conf in place" ;;
*) die "usage: storage.sh enable | apply | check" ;;
esac
