#!/usr/bin/env bash
# Nightly backup of the workbox's subvolumes to a Hetzner Storage Box with
# btrbk (btrbk.conf says how). Root only.
#
#   backup.sh install          keys, env file, systemd timer (provision.sh backup)
#   backup.sh run              one backup now (the timer runs this nightly)
#   backup.sh list             what the Storage Box holds
#   backup.sh subvolumes       the subvolumes a run backs up, one per line
#   backup.sh restore NAME DIR receives NAME's chain from this month (or
#                              HB_BACKUP_MONTH=YYYY-MM) into DIR, a directory on
#                              a btrfs; README.md, Restore, has the rest
#
# Env (install): HB_STORAGEBOX_HOST (uXXXXX.your-storagebox.de),
# HB_STORAGEBOX_USER (uXXXXX or a sub-account), HB_STORAGEBOX_PORT (23).
# HB_BACKUP_DIR replaces the sshfs mount with a local directory (test.sh).
set -euo pipefail
# shellcheck source=common.sh
. "$(dirname "$0")/common.sh"
[[ ${1:-} == subvolumes ]] || hb_require_host

etc=${HB_ETC:-/etc}
conf_dir=$etc/btrbk
key=${HB_BACKUP_KEY:-$conf_dir/backup.key}
ssh_key=$conf_dir/ssh/id_ed25519
env_file=$etc/hetzner-workbox/backup.env
mnt=${HB_BACKUP_MOUNT:-/mnt/storagebox}
snap_dir=${HB_SNAPSHOT_DIR:-/var/lib/btrbk/snapshots}
# What is backed up: the home and the durable run areas (@runs), with every subvolume nested in them
# but the caches (storage.conf's cache lines: tools rebuild them). /workspaces is not: the owner's
# ruling (2026-11, "skip workspaces"): its lanes and bases are rebuilt from git, and pushed work lives
# on GitHub. Run records are not workspaces, so they live in @runs, outside it.
HB_BACKUP_SUBVOLS=${HB_BACKUP_SUBVOLS:-"$HB_HOME $HB_RUNS"}
HB_STORAGE_CONF=${HB_STORAGE_CONF:-$hb_dir/storage.conf}
host_name=${HB_BACKUP_NAME:-$HB_HOSTNAME}

need_root

# A subvolume path to a snapshot name btrbk accepts: /workspaces/.rifts/bite/x -> workspaces._rifts.bite.x
snap_name() { local p=${1#/}; p=${p//./_}; p=${p//\//.}; printf '%s' "${p//[^A-Za-z0-9_.+-]/_}"; }

do_install() {
    [[ -n ${HB_STORAGEBOX_HOST:-} && -n ${HB_STORAGEBOX_USER:-} ]] || die "set HB_STORAGEBOX_HOST and HB_STORAGEBOX_USER"
    need btrbk sshfs openssl zstd
    install -d -m 700 "$conf_dir" "$conf_dir/ssh"
    install -d -m 755 "$etc/hetzner-workbox" "$snap_dir" "$mnt"
    printf 'WORKBOX_EXPECT_MACHINE_ID=%s\n' "$WORKBOX_EXPECT_MACHINE_ID" > "$etc/hetzner-workbox/host-identity.env"
    if [[ ! -s $key ]]; then
        # 256-bit key in hex, as btrbk's openssl_keyfile wants it.
        (umask 077; openssl rand -hex 32 > "$key")
        say "new backup key $key: copy it off the box now (the owner's password manager); without it the backups cannot be read"
    fi
    [[ -f $ssh_key ]] || ssh-keygen -q -t ed25519 -N '' -C "btrbk@$host_name" -f "$ssh_key"
    printf 'HB_STORAGEBOX_HOST=%s\nHB_STORAGEBOX_USER=%s\nHB_STORAGEBOX_PORT=%s\n' \
        "$HB_STORAGEBOX_HOST" "$HB_STORAGEBOX_USER" "${HB_STORAGEBOX_PORT:-23}" > "$env_file"
    chmod 600 "$env_file"
    install -m 0644 "$hb_dir/systemd/hetzner-backup.service" "$etc/systemd/system/hetzner-backup.service"
    install -m 0644 "$hb_dir/systemd/hetzner-backup.timer" "$etc/systemd/system/hetzner-backup.timer"
    systemctl daemon-reload
    systemctl enable --now hetzner-backup.timer >/dev/null
    say "Give the Storage Box this key (once, it asks for the box's password):"
    printf '  cat %s.pub | ssh -p23 %s@%s install-ssh-key\n' "$ssh_key" "$HB_STORAGEBOX_USER" "$HB_STORAGEBOX_HOST"
}

mounted_here=0
base=
# Sets base to the Storage Box's root here, mounting it when needed (not in a
# subshell, so storage_umount knows).
storage_mount() {
    if [[ -n ${HB_BACKUP_DIR:-} ]]; then base=$HB_BACKUP_DIR; return; fi
    if ! mountpoint -q "$mnt"; then
        [[ -f $env_file ]] || die "no $env_file: run backup.sh install"
        # shellcheck disable=SC1090
        . "$env_file"
        install -d -m 755 "$mnt"
        sshfs -p "${HB_STORAGEBOX_PORT:-23}" \
            -o "IdentityFile=$ssh_key,IdentitiesOnly=yes,StrictHostKeyChecking=accept-new,UserKnownHostsFile=$conf_dir/ssh/known_hosts" \
            -o reconnect,ServerAliveInterval=15,ServerAliveCountMax=3 \
            "$HB_STORAGEBOX_USER@$HB_STORAGEBOX_HOST:./" "$mnt"
        mounted_here=1
    fi
    base=$mnt
}
storage_umount() { if ((mounted_here)); then fusermount -u "$mnt" || true; fi; }

# The caches as paths here (storage.conf's cache lines; ~ is the home).
cache_paths() {
    local kind path rest
    while read -r kind path rest; do
        [[ $kind == cache ]] || continue
        case $path in
        "~" | "~"/*) echo "$HB_HOME${path#"~"}" ;;
        /workspaces | /workspaces/*) echo "$HB_WORKSPACES${path#/workspaces}" ;;
        /runs | /runs/*) echo "$HB_RUNS${path#/runs}" ;;
        *) echo "$HB_TARGET$path" ;;
        esac
    done < <(sed -e 's/#.*//' "$HB_STORAGE_CONF" 2>/dev/null)
}
is_cache() { local c; for c in $caches; do [[ $1 == "$c" || $1 == "$c"/* ]] && return 0; done; return 1; }

# Every subvolume to back up: the roots and every subvolume nested under them.
subvols() {
    local root caches
    caches=$(cache_paths)
    for root in $HB_BACKUP_SUBVOLS; do
        is_btrfs "$root" || die "$root is not a btrfs mount"
        echo "$root"
        local fsr
        fsr=$(mount_fsroot "$root")
        fsr=${fsr#/}
        btrfs subvolume list -a "$root" | awk -v r="$fsr/" '{ p = $NF; sub(/^<FS_TREE>\//, "", p); if (index(p, r) == 1) print substr(p, length(r) + 1) }' |
            while read -r rel; do
                # Read-only subvolumes are snapshots already (btrbk skips them too).
                [[ $(btrfs property get -ts "$root/$rel" ro 2>/dev/null) == ro=true ]] && continue
                is_cache "$root/$rel" && continue
                echo "$root/$rel"
            done
    done
}

render() { # target dir -> config on stdout
    sed -e "s|@KEYFILE@|$key|" -e "s|^snapshot_dir .*|snapshot_dir            $snap_dir|" "$hb_dir/btrbk.conf"
    printf '\n'
    local s
    while read -r s; do
        printf 'subvolume %s\n  snapshot_name %s\n  target raw %s\n' "$s" "$(snap_name "$s")" "$1"
    done < <(subvols)
}

do_run() {
    need btrbk
    local dir month conf names
    install -d -m 700 "$snap_dir"
    storage_mount
    trap storage_umount EXIT
    month=${HB_BACKUP_MONTH:-$(date -u +%Y-%m)}
    dir=$base/$host_name/$month
    install -d "$dir"
    conf=$(mktemp)
    render "$dir" > "$conf"
    # snapshot_create onchange compares generations, which move only when a
    # transaction commits: commit now, so the last seconds' writes count.
    local r
    for r in $HB_BACKUP_SUBVOLS; do btrfs filesystem sync "$r"; done
    btrbk -c "$conf" -q run
    # Snapshots of subvolumes that are gone (a removed Rift), past the 14 days.
    names=$(awk '/^ *snapshot_name /{ print $2 }' "$conf")
    local s n
    for s in "$snap_dir"/*; do
        [[ -d $s ]] || continue
        n=${s##*/}
        n=${n%.*}
        grep -qxF "$n" <<<"$names" && continue
        if [[ -n $(find "$s" -maxdepth 0 -mtime +14) ]]; then
            btrfs subvolume delete "$s" >/dev/null
            say "dropped orphan snapshot $s"
        fi
    done
    rm -f "$conf"
    # Keep this month and the last: a chain needs its full backup.
    local keep_prev d
    keep_prev=$(date -u -d "$month-01 -1 month" +%Y-%m)
    for d in "$base/$host_name"/*; do
        [[ -d $d ]] || continue
        case ${d##*/} in "$month" | "$keep_prev") ;; *) rm -rf -- "$d"; say "dropped ${d##*/}" ;; esac
    done
    say "backup done: $dir"
}

do_list() {
    storage_mount
    trap storage_umount EXIT
    find "$base/$host_name" -name '*.info' -printf '%TY-%Tm-%Td %p\n' | sort
}

do_restore() {
    local name=$1 dest=$2 dir f info file iv cipher
    [[ -n $name && -d $dest ]] || die "usage: backup.sh restore NAME DIR"
    need openssl zstd
    storage_mount
    trap storage_umount EXIT
    dir=$base/$host_name/${HB_BACKUP_MONTH:-$(date -u +%Y-%m)}
    # The chain in time order: the full backup, then each night against the one before.
    local n=0
    for info in "$dir/$name".*.info; do
        [[ -f $info ]] || die "no backups of $name in $dir"
        file=$(awk -F= '$1 == "FILE" { print $2 }' "$info")
        iv=$(awk -F= '$1 == "iv" { print $2 }' "$info")
        cipher=$(awk -F= '$1 == "cipher" { print $2 }' "$info")
        f=$dir/$file
        say "receiving $file"
        openssl enc -d "-$cipher" -K "$(cat "$key")" ${iv:+-iv "$iv"} -in "$f" | zstd -dcq | btrfs receive -q "$dest"
        n=$((n + 1))
    done
    say "$n snapshots of $name in $dest; the newest is the last night's state"
}

case ${1:-} in
install) do_install ;;
run) do_run ;;
list) do_list ;;
restore) do_restore "${2:-}" "${3:-}" ;;
subvolumes) subvols ;;
*) die "usage: backup.sh install | run | list | subvolumes | restore NAME DIR" ;;
esac
