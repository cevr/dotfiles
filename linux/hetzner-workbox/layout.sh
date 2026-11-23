#!/usr/bin/env bash
# Finishes installimage's layout on the second drive. Run once as root on the
# installed system's first boot (from a plain ssh root shell); a rerun only
# checks. installimage.conf says why it is split this way.
#
#   1. copies DRIVE1's partition table to DRIVE2 (new partition ids);
#   2. adds DRIVE2's btrfs partition to the root file system and converts data
#      and metadata to raid1;
#   3. mirrors /boot with mdraid1 (ext4): a degraded array on DRIVE2, the files
#      copied, the fstab switched, then DRIVE1's partition joins it;
#   4. mirrors swap with mdraid1;
#   5. formats DRIVE2's ESP, copies DRIVE1's onto it, and has GRUB install to
#      both drives (Ubuntu's grub-multi-install keeps both ESPs in step);
#   6. writes the btrfs mount options and UUIDs into the fstab, /tmp 1777.
#   7. turns on btrfs simple quotas (storage.sh enable; btrfs-progs from system-tools.sh btrfs
#      where the release's is older than 6.7): now, before anything but the OS is on the disk,
#      so every byte provision.sh, sync.sh and the work write later is counted (README.md, Layout).
#
# Usage: sudo layout.sh [--dry-run]
# Env: HB_DISK1 HB_DISK2 (default /dev/nvme0n1 /dev/nvme1n1), HB_TARGET (the
# installed root, empty on the box), HB_BOOTLOADER=0 skips GRUB and initramfs
# (test.sh), HB_MD_PREFIX names the arrays apart (test.sh).
set -euo pipefail
# shellcheck source=common.sh
. "$(dirname "$0")/common.sh"

HB_DISK1=${HB_DISK1:-/dev/nvme0n1}
HB_DISK2=${HB_DISK2:-/dev/nvme1n1}
HB_MDADM_CONF=${HB_MDADM_CONF:-$HB_TARGET/etc/mdadm/mdadm.conf}
HB_BOOTLOADER=${HB_BOOTLOADER:-1}
HB_MD_PREFIX=${HB_MD_PREFIX:-}
dry=0
[[ ${1:-} == --dry-run ]] && dry=1
root=${HB_TARGET:-/}

need_root
need btrfs mdadm sfdisk wipefs blkid findmnt mkfs.ext4 mkfs.vfat mkswap lsblk
[[ -b $HB_DISK1 && -b $HB_DISK2 ]] || die "not block devices: $HB_DISK1 $HB_DISK2"
[[ $(readlink -f "$HB_DISK1") != "$(readlink -f "$HB_DISK2")" ]] || die "DRIVE1 and DRIVE2 are the same device"

run() { if ((dry)); then printf 'would run: %s\n' "$*"; else "$@"; fi; }
# Box-relative path to the path on this host (HB_TARGET prefix in tests).
at() { if [[ $1 == / ]]; then echo "$root"; else echo "$HB_TARGET$1"; fi; }

blk() { basename "$(readlink -f "$1")"; }
partnum() { cat "/sys/class/block/$(blk "$1")/partition"; }
disk_of() { basename "$(readlink -f "/sys/class/block/$(blk "$1")/..")"; }
on_disk1() { [[ $(disk_of "$1") == "$(blk "$HB_DISK1")" ]]; }
# DRIVE2's partition with the same number as DRIVE1's partition $1.
twin() {
    local n p d2
    n=$(partnum "$1")
    d2=$(blk "$HB_DISK2")
    for p in /sys/class/block/"$d2"/"$d2"*; do
        [[ -f $p/partition && $(cat "$p/partition") == "$n" ]] && { echo "/dev/${p##*/}"; return; }
    done
    die "DRIVE2 has no partition $n"
}
fstype() { blkid -p -o value -s TYPE "$1" 2>/dev/null || true; }
uuid() { blkid -o value -s UUID "$1"; }

backup_fstab() {
    local b=$HB_FSTAB.hetzner-layout
    [[ -e $b ]] || cp -p "$HB_FSTAB" "$b"
}
# Rewrites the fstab with an awk program; one backup, kept from the first run.
edit_fstab() {
    ((dry)) && { printf 'would edit %s: %s\n' "$HB_FSTAB" "$*"; return; }
    backup_fstab
    local tmp
    tmp=$(mktemp "$HB_FSTAB.XXXXXX")
    awk "$@" "$HB_FSTAB" > "$tmp"
    chmod --reference="$HB_FSTAB" "$tmp"
    mv "$tmp" "$HB_FSTAB"
}

# --- 1. DRIVE2's partition table.
partitions() { lsblk -nr -o NAME,TYPE "$1" | awk '$2 == "part"' | wc -l; }
n1=$(partitions "$HB_DISK1")
n2=$(partitions "$HB_DISK2")
if ((n2 == 0)); then
    say "copying the partition table of $HB_DISK1 to $HB_DISK2"
    # A signature on DRIVE2 means it is not the blank drive we expect.
    [[ -z $(wipefs -n "$HB_DISK2" 2>/dev/null | tail -n +2) ]] || die "$HB_DISK2 holds a signature; wipe it on purpose first (wipefs -a $HB_DISK2)"
    # Without label-id and uuid sfdisk makes new ones, so the drives do not share ids.
    if ((dry)); then
        echo "would run: sfdisk -d $HB_DISK1 | sfdisk $HB_DISK2"
    else
        sfdisk -d "$HB_DISK1" | sed -e '/^label-id:/d' -e 's/, *uuid=[0-9A-Fa-f-]*//' | sfdisk -q "$HB_DISK2"
        udevadm settle 2>/dev/null || true
    fi
elif ((n2 != n1)); then
    die "$HB_DISK2 has $n2 partitions, $HB_DISK1 has $n1; expected none or the same"
else
    say "ok: $HB_DISK2 is partitioned"
fi
((dry)) && ((n2 == 0)) && { say "dry run stops here: DRIVE2 has no partitions yet"; exit 0; }

# --- 2. btrfs raid1.
is_btrfs "$root" || die "$root is not btrfs"
fs_dev=
for d in $(btrfs filesystem show "$root" | awk '/ path /{ print $NF }'); do
    if on_disk1 "$d"; then fs_dev=$d; break; fi
done
[[ -n $fs_dev ]] || die "no btrfs device of $root on $HB_DISK1"
fs_twin=$(twin "$fs_dev")
if btrfs filesystem show "$root" | awk '/ path /{ print $NF }' | grep -qx "$fs_twin"; then
    say "ok: $fs_twin is in the btrfs"
else
    say "adding $fs_twin to the btrfs"
    run btrfs device add -f "$fs_twin" "$root"
fi
if btrfs filesystem df "$root" | awk -F'[,:]' '$1 ~ /^(Data|Metadata|System)$/ && $2 !~ /RAID1/ { bad = 1 } END { exit !bad }'; then
    say "converting data and metadata to raid1 (a fresh install: seconds)"
    run btrfs balance start -dconvert=raid1,soft -mconvert=raid1,soft "$root"
else
    say "ok: data and metadata are raid1"
fi

# --- 3. /boot on mdraid1.
md_dev() { echo "/dev/md/$HB_MD_PREFIX$1"; }
md_create() { # name metadata members...
    local name=$1 meta=$2
    shift 2
    run mdadm --create "$(md_dev "$name")" --run --level=1 --raid-devices=2 --metadata="$meta" \
        --name="$HB_MD_PREFIX$name" --homehost=any "$@"
    ((dry)) || udevadm settle 2>/dev/null || true
}
boot=$(at /boot)
boot_src=$(mount_source "$boot")
[[ -n $boot_src ]] || die "/boot is not mounted"
if [[ $(readlink -f "$boot_src") == /dev/md* ]]; then
    say "ok: /boot is on $boot_src"
else
    on_disk1 "$boot_src" || die "/boot ($boot_src) is not on $HB_DISK1"
    p2=$(twin "$boot_src")
    md=$(md_dev boot)
    say "mirroring /boot: $md from $p2, then $boot_src"
    run wipefs -a -q "$p2"
    md_create boot 1.2 missing "$p2"
    run mkfs.ext4 -q -L boot "$md"
    if ((!dry)); then
        stage=$(mktemp -d)
        mount "$md" "$stage"
        # -x: the ESP mounted at /boot/efi stays out; its mount point comes along.
        cp -ax "$boot/." "$stage/"
        umount "$stage"
        rmdir "$stage"
        md_uuid=$(uuid "$md")
        edit_fstab -v u="$md_uuid" '$2 == "/boot" { $1 = "UUID=" u } { print }'
        efi=$(at /boot/efi)
        efi_src=$(mount_source "$efi")
        [[ -z $efi_src ]] || umount "$efi"
        umount "$boot"
        mount "$md" "$boot"
        [[ -z $efi_src ]] || mount "$efi_src" "$efi"
    fi
    run wipefs -a -q "$boot_src"
    run mdadm --add "$md" "$boot_src"
fi

# --- 4. swap on mdraid1.
swaps=$(awk 'NR > 1 && $2 == "partition" { print $1 }' /proc/swaps)
for s in $swaps; do
    [[ $(readlink -f "$s") == /dev/md* ]] && { say "ok: swap is on $s"; continue; }
    on_disk1 "$s" || continue
    s2=$(twin "$s")
    old_uuid=$(uuid "$s" || true)
    md=$(md_dev swap)
    say "mirroring swap: $md from $s and $s2"
    run swapoff "$s"
    run wipefs -a -q "$s" "$s2"
    md_create swap 1.2 "$s" "$s2"
    run mkswap -q -L swap "$md"
    if ((!dry)); then
        edit_fstab -v u="$(uuid "$md")" -v d="$s" -v o="UUID=$old_uuid" \
            '$3 == "swap" && ($1 == d || $1 == o) { $1 = "UUID=" u } { print }'
    fi
    run swapon "$md"
done

# --- 5. The second ESP.
efi=$(at /boot/efi)
efi_src=$(mount_source "$efi")
if [[ -n $efi_src ]] && on_disk1 "$efi_src"; then
    e2=$(twin "$efi_src")
    if [[ $(fstype "$e2") != vfat ]]; then
        say "formatting $e2 as the second ESP"
        run mkfs.vfat -F 32 -n EFI2 "$e2" >/dev/null
    fi
    if ((!dry)); then
        stage=$(mktemp -d)
        mount "$e2" "$stage"
        # vfat keeps no owners; copy the files and their times.
        cp -r --preserve=timestamps "$efi/." "$stage/"
        umount "$stage"
        rmdir "$stage"
    fi
    say "ok: $e2 holds a copy of the ESP"
fi
if ((HB_BOOTLOADER)); then
    # Ubuntu's grub-multi-install installs to every device in install_devices on
    # each GRUB update, so both drives stay bootable.
    id_of() { local l; for l in /dev/disk/by-id/nvme-eui.* /dev/disk/by-id/*; do [[ $(readlink -f "$l") == "$(readlink -f "$1")" ]] && { echo "$l"; return; }; done; echo "$1"; }
    if [[ -d /sys/firmware/efi ]]; then
        devs="$(id_of "$efi_src"), $(id_of "$e2")"
        say "GRUB (UEFI) on $devs"
        run sh -c "echo 'grub-efi-amd64 grub-efi/install_devices multiselect $devs' | debconf-set-selections"
        run dpkg-reconfigure -f noninteractive grub-efi-amd64
    else
        devs="$(id_of "$HB_DISK1"), $(id_of "$HB_DISK2")"
        say "GRUB (BIOS) on $devs"
        run sh -c "echo 'grub-pc grub-pc/install_devices multiselect $devs' | debconf-set-selections"
        run grub-install "$HB_DISK1"
        run grub-install "$HB_DISK2"
    fi
    run update-grub
fi

# --- 6. mdadm.conf, the btrfs lines, /tmp.
if ((!dry)); then
    mkdir -p "$(dirname "$HB_MDADM_CONF")"
    touch "$HB_MDADM_CONF"
    tmp=$(mktemp)
    # Our arrays' lines, by device or by name, go; mdadm writes them again.
    grep -v -E "^ARRAY (/dev/md/($HB_MD_PREFIX)(boot|swap) |.*name=([^ ]*:)?($HB_MD_PREFIX)(boot|swap)( |$))" "$HB_MDADM_CONF" > "$tmp" || true
    for n in boot swap; do
        [[ -e $(md_dev "$n") ]] && mdadm --detail --brief "$(md_dev "$n")" >> "$tmp"
    done
    cat "$tmp" > "$HB_MDADM_CONF"
    rm -f "$tmp"
fi
fs_uuid=$(btrfs filesystem show "$root" | awk '/uuid:/ { print $NF; exit }')
edit_fstab -v u="$fs_uuid" -v o="$hb_btrfs_opts" '
    $3 == "btrfs" {
        sv = ""
        n = split($4, a, ",")
        for (i = 1; i <= n; i++) if (a[i] ~ /^subvol=/) sv = a[i]
        $1 = "UUID=" u
        $4 = (sv == "" ? o : sv "," o)
    }
    { print }'
for pair in $hb_subvols; do
    mp=$(at "${pair#*:}")
    is_btrfs "$mp" && run mount -o remount,noatime,compress=zstd:3,discard=async,user_subvol_rm_allowed "$mp"
done
tmpdir=$(at /tmp)
[[ $(stat -c %a "$tmpdir") == 1777 ]] || run chmod 1777 "$tmpdir"
if ((HB_BOOTLOADER)); then
    run update-initramfs -u -k all
fi

# --- 7. Simple quotas.
if ((dry)); then
    echo "would run: system-tools.sh btrfs; storage.sh enable"
else
    "$hb_dotfiles/workbox/system-tools.sh" btrfs
    "$hb_dir/storage.sh" enable
fi

say "layout done; reboot, then run check.sh (it must print only ok lines)"
