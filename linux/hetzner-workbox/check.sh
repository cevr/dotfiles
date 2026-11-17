#!/usr/bin/env bash
# Checks the Hetzner workbox's storage and system layer. Prints one line per
# check (ok, warn, FAIL) and exits 1 on any FAIL. Run as root.
# HB_CHECK_SKIP lists checks to leave out (test.sh: "firewall sshd backup").
set -euo pipefail
# shellcheck source=common.sh
. "$(dirname "$0")/common.sh"

HB_CHECK_SKIP=${HB_CHECK_SKIP:-}
root=${HB_TARGET:-/}
fails=0
ok() { printf 'ok: %s\n' "$*"; }
bad() { printf 'FAIL: %s\n' "$*"; fails=$((fails + 1)); }
note() { printf 'warn: %s\n' "$*"; }
skip() { [[ " $HB_CHECK_SKIP " == *" $1 "* ]]; }
at() { if [[ $1 == / ]]; then echo "$root"; else echo "$HB_TARGET$1"; fi; }

need_root

# --- btrfs raid1 across two devices.
if is_btrfs "$root"; then
    devs=$(btrfs filesystem show "$root" | grep -c ' path ')
    ((devs == 2)) && ok "btrfs on 2 devices" || bad "btrfs on $devs devices, want 2 (layout.sh)"
    profiles=$(btrfs filesystem df "$root" | awk -F'[,:]' '$1 ~ /^(Data|Metadata|System)$/ { gsub(/ /, "", $2); print $1 "=" $2 }' | sort -u | tr '\n' ' ')
    if [[ $profiles == *single* || $profiles == *DUP* ]]; then bad "btrfs profiles: $profiles(want RAID1)"; else ok "btrfs profiles: $profiles"; fi
    if btrfs device stats -c "$root" >/dev/null 2>&1; then ok "btrfs device errors: none"; else bad "btrfs device stats show errors: btrfs device stats $root"; fi
else
    bad "$root is not btrfs"
fi

# --- Each subvolume at its mount point, and the top level nowhere.
for pair in $hb_subvols; do
    name=${pair%%:*}
    mp=$(at "${pair#*:}")
    fsr=$(mount_fsroot "$mp")
    if [[ $fsr == "/$name" ]]; then ok "$mp is $name"; else bad "$mp is not $name (it mounts ${fsr:-nothing})"; fi
done
dev=$(findmnt -rn -o MAJ:MIN --mountpoint "$root")
tops=$(findmnt -rn -o TARGET,MAJ:MIN,FSROOT | awk -v d="$dev" '$2 == d && $3 == "/" { print $1 }' | grep -v '^/var/lib/hetzner-sync/top$' || true)
[[ -z $tops ]] && ok "no mount of the btrfs top level" || bad "the top level is mounted at: $tops (Ergo's sweep refuses a checkout it sees twice)"
mountpoint -q /var/lib/hetzner-sync/top 2>/dev/null && note "sync.sh's top-level mount is still there: umount /var/lib/hetzner-sync/top"

# --- fstab: btrfs by UUID with the options; /boot and swap on md.
if awk '$3 == "btrfs"' "$HB_FSTAB" | grep -q .; then
    awk '$3 == "btrfs" && ($1 !~ /^UUID=/ || $4 !~ /compress=zstd:3/ || $4 !~ /noatime/ || ("," $4 ",") !~ /,user_subvol_rm_allowed,/) { exit 1 }' "$HB_FSTAB" &&
        ok "fstab btrfs lines: UUID, compress=zstd:3, noatime, user_subvol_rm_allowed" || bad "fstab btrfs lines lack UUID= or the options (layout.sh)"
else
    bad "no btrfs line in $HB_FSTAB"
fi
boot_src=$(mount_source "$(at /boot)")
if [[ $(readlink -f "$boot_src") == /dev/md* ]]; then ok "/boot on $boot_src"; else bad "/boot is on ${boot_src:-nothing}, not mdraid1"; fi
swap_md=
for s in $(awk 'NR > 1 { print $1 }' /proc/swaps); do
    if [[ $(readlink -f "$s") == /dev/md* ]]; then swap_md="$swap_md $s"; fi
done
swap_md=${swap_md# }
[[ -n $swap_md ]] && ok "swap on $swap_md" || bad "no swap on mdraid1"
for md in $(readlink -f "$boot_src") $swap_md; do
    [[ $(readlink -f "$md") == /dev/md* ]] || continue
    state=$(mdadm --detail "$md" | awk -F' : ' '/State :/ { print $2 }')
    active=$(mdadm --detail "$md" | awk -F' : ' '/Active Devices/ { print $2 }')
    if [[ $active == 2 && $state != *degraded* ]]; then ok "$md: 2 active, $state"; else bad "$md: $active active, $state"; fi
done

# --- /tmp, and reflinks where Rift needs them.
[[ $(stat -c %a "$(at /tmp)") == 1777 ]] && ok "/tmp is 1777" || bad "/tmp mode is $(stat -c %a "$(at /tmp)")"
for d in "$HB_HOME" "$HB_WORKSPACES"; do
    [[ -d $d ]] || { bad "$d is missing"; continue; }
    f=$(mktemp "$d/.hb-check.XXXXXX")
    printf x > "$f"
    if cp --reflink=always "$f" "$f.copy" 2>/dev/null; then ok "reflinks work in $d"; else bad "no reflinks in $d"; fi
    rm -f "$f" "$f.copy"
done
owner=$(stat -c %U "$HB_HOME")
[[ $owner == "$HB_USER" ]] && ok "$HB_HOME belongs to $HB_USER" || bad "$HB_HOME belongs to $owner"

# --- The system layer.
if ! skip firewall; then
    nft list table inet hetzner_workbox >/dev/null 2>&1 && ok "firewall loaded" || bad "firewall table hetzner_workbox is not loaded (provision.sh firewall)"
fi
if ! skip sshd; then
    listen=$(awk '/^ListenAddress/ { print $2 }' /etc/ssh/bite-workbox-sshd_config 2>/dev/null || true)
    if [[ -n $listen ]] && ss -ltn "sport = :2222" | grep -q "$listen:2222"; then ok "sshd on $listen:2222"; else bad "no sshd on the Tailscale address :2222"; fi
fi
if ! skip backup; then
    systemctl is-enabled --quiet hetzner-backup.timer 2>/dev/null && ok "backup timer enabled" || note "backup timer not enabled (provision.sh backup)"
fi

((fails == 0)) || { printf '%d checks failed\n' "$fails"; exit 1; }
