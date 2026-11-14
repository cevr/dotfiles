# shellcheck shell=bash disable=SC2034
# Shared settings for grow.sh, migrate.sh and check.sh. Sourced, not run.
#
# Every path hangs off WB_ROOT (empty on the workbox), so test.sh can run the
# same scripts inside a scratch root: a loop ext4 holding a loop btrfs.

WB_ROOT=${WB_ROOT:-}
WB_USER=${WB_USER:-${SUDO_USER:-$(id -un)}}
WB_DISK=${WB_DISK:-/dev/vda}
# Headroom the ext4 root keeps beyond the OS core; README.md says why 40 GiB.
WB_HEADROOM_GIB=${WB_HEADROOM_GIB:-40}

wb_root=${WB_ROOT:-/}
wb_home=$WB_ROOT/home/$WB_USER
wb_tmp=$WB_ROOT/tmp
wb_image=$WB_ROOT/var/lib/bite-workspaces.btrfs
wb_workspaces=$WB_ROOT/workspaces
wb_fstab=${WB_FSTAB:-$WB_ROOT/etc/fstab}
wb_state=$WB_ROOT/var/lib/workbox-btrfs
# pam_nologin refuses every non-root login while it exists.
wb_nologin=$WB_ROOT/run/nologin
# Moved-aside trees wait here until `migrate.sh finish`.
wb_old_home=$wb_home.pre-btrfs
# Worktrees turned into Rifts: name, branch, old path, Rift path.
wb_converted=$wb_home/.local/state/workbox-btrfs/converted.tsv
wb_opts=noatime,compress=zstd:3,space_cache=v2,discard=async
# The subvolumes, each with its mount point. The image line in the fstab mounts
# @workspaces at /workspaces; the UUID lines mount these two.
wb_subvols="@home:$wb_home @tmp:$wb_tmp"
wb_ws_subvol=@workspaces
# The top level of the image is mounted nowhere: a mount of it shows every
# subvolume a second time, and Ergo's closure sweep refuses a checkout it can
# see twice. `migrate.sh workspaces --undo` mounts it here, for root, for the
# length of the undo.
wb_top=$wb_state/top

say() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf '%s: %s\n' "${0##*/}" "$*" >&2; exit 1; }
gib() { awk -v b="$1" 'BEGIN { printf "%.1f GiB", b / 1073741824 }'; }

# Runs a command as root: directly when already root, else through sudo.
as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }
# Runs a command as the home's owner.
as_user() { if [ "$(id -un)" = "$WB_USER" ]; then "$@"; else runuser -u "$WB_USER" -- "$@"; fi; }

ext4_total() { df -B1 --output=size "$wb_root" | awk 'NR == 2 { print $1 }'; }
# Free space an unprivileged writer sees; the loop device writes as the kernel,
# but counting the reserved blocks as free would hide a full disk.
ext4_free() { df -B1 --output=avail "$wb_root" | awk 'NR == 2 { print $1 }'; }
image_size() { stat -c %s "$wb_image"; }
# Bytes the sparse image holds on ext4.
image_alloc() { echo $(($(stat -c %b "$wb_image") * $(stat -c %B "$wb_image"))); }

image_uuid() { as_root blkid -p -s UUID -o value "$wb_image"; }
image_loop() { losetup -n -O NAME -j "$wb_image" | head -n 1; }

is_btrfs_mount() { [ "$(findmnt -n -o FSTYPE --mountpoint "$1" 2>/dev/null)" = btrfs ]; }
mount_subvol() { findmnt -n -o FSROOT --mountpoint "$1" 2>/dev/null; }
# Every mount of the image's top level ("/"), wherever it is: the mounts Ergo's
# sweep refuses. findmnt pads MAJ:MIN unless -r.
top_mounts() {
    local dev
    dev=$(findmnt -rn -o MAJ:MIN --mountpoint "$wb_workspaces" 2>/dev/null) || return 0
    findmnt -rn -o TARGET,MAJ:MIN,FSROOT | awk -v d="$dev" '$2 == d && $3 == "/" { print $1 }'
}
# The options of the fstab line that mounts the image at /workspaces.
image_line_opts() {
    awk -v img="$wb_image" -v mp="$wb_workspaces" '$1 == img && $2 == mp && $3 == "btrfs" { print $4; exit }' "$wb_fstab"
}

# The fstab line of one subvolume. The image line comes first in the file, and
# requires-mounts-for orders each subvolume after the loop mount at boot.
fstab_line() {
    printf 'UUID=%s %s btrfs subvol=%s,%s,x-systemd.requires-mounts-for=%s 0 0\n' \
        "$1" "$3" "$2" "$wb_opts" "$wb_workspaces"
}

# Prints "pid<TAB>command<TAB>path" for each process holding a file, a
# directory, a memory map or its working directory under any of the paths.
holders() {
    lsof -nP -w -F pcn 2>/dev/null | awk -v roots="$*" '
        BEGIN { n = split(roots, r, " ") }
        /^p/ { pid = substr($0, 2); next }
        /^c/ { cmd = substr($0, 2); next }
        /^n/ {
            name = substr($0, 2)
            for (i = 1; i <= n; i++)
                if (name == r[i] || index(name, r[i] "/") == 1) { print pid "\t" cmd "\t" name; break }
        }' | sort -u -t '	' -k1,1n
}
