#!/usr/bin/env bash
# Grows the ext4 root to the disk, then grows the sparse btrfs image as far as
# ext4 can back it: the image may hold every byte ext4 has free, minus the
# headroom. Never shrinks anything; rerun it any time (after a disk resize, or
# after `migrate.sh finish` frees the old home and /tmp on ext4).
#
#   grow.sh            grow what can grow
#   grow.sh --dry-run  print the sizes and what it would do
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd -P)
. "$here/common.sh"

dry=false
case ${1:-} in
    '') ;;
    --dry-run) dry=true ;;
    *) die 'usage: grow.sh [--dry-run]' ;;
esac
[[ $(uname -s) == Linux ]] || die 'requires Linux'
[[ -f $wb_image ]] || die "no image at $wb_image"
is_btrfs_mount "$wb_workspaces" || die "$wb_workspaces is not a mounted btrfs"
run() { if $dry; then printf '[dry-run] %s\n' "$*"; else as_root "$@"; fi; }
gib_floor() { echo $(($1 / 1073741824 * 1073741824)); }

# 1. ext4. The owner grows the disk (exe.dev resize); x-systemd.growfs grows the
# file system only at boot, so grow it online here.
disk=$(as_root blockdev --getsize64 "$WB_DISK")
read -r blocks block_size < <(as_root dumpe2fs -h "$WB_DISK" 2>/dev/null |
    awk -F: '/^Block count/ { c = $2 } /^Block size/ { s = $2 } END { print c + 0, s + 0 }')
fs=$((blocks * block_size))
if ((disk - fs >= 64 * 1048576)); then
    say "Growing ext4 on $WB_DISK from $(gib "$fs") to $(gib "$disk")"
    run resize2fs "$WB_DISK"
else
    say "ext4 already fills $WB_DISK ($(gib "$fs"))"
fi
# ext4 reserves 5% for root by default (39 GiB of an 800 GiB disk). Users live
# on btrfs now and the headroom protects the core, so keep 1%.
reserved=$(as_root dumpe2fs -h "$WB_DISK" 2>/dev/null | awk -F: '/^Reserved block count/ { print $2 + 0 }')
if ((reserved * 100 > blocks * 1 + blocks / 100)); then
    say "Lowering ext4's root reserve from $(gib $((reserved * block_size))) to 1%"
    run tune2fs -m 1 "$WB_DISK" >/dev/null
fi

# 2. The image. Its unallocated part must always fit in ext4's free space, with
# the headroom left over for the OS core: size <= allocated + free - headroom.
headroom=$((WB_HEADROOM_GIB * 1073741824))
size=$(image_size)
alloc=$(image_alloc)
free=$(ext4_free)
target=$(gib_floor $((alloc + free - headroom)))
say "ext4 free $(gib "$free"), image $(gib "$size") holding $(gib "$alloc"), headroom $(gib "$headroom")"
if ((target > size)); then
    say "Growing the image to $(gib "$target")"
    run truncate -s "$target" "$wb_image"
    loop=$(image_loop)
    [[ -n $loop ]] || die "no loop device holds $wb_image"
    run losetup -c "$loop"
else
    say "The image stays at $(gib "$size"); ext4 can back $(gib "$target")"
    ((size - alloc <= free)) ||
        warn "the image's unallocated $(gib $((size - alloc))) exceeds ext4's free $(gib "$free"): btrfs could fill ext4. Free ext4 (migrate.sh moves home and /tmp) or grow the disk."
fi
# A no-op when btrfs already fills the loop device.
run btrfs filesystem resize max "$wb_workspaces" >/dev/null
$dry || say "btrfs now spans $(gib "$(as_root blockdev --getsize64 "$(image_loop)")")"
