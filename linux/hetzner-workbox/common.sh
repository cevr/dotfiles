# shellcheck shell=bash disable=SC2034
# Shared settings for layout.sh, provision.sh, sync.sh, check.sh and backup.sh.
# Sourced, not run. Every path can be moved with an HB_* variable so test.sh
# runs the same scripts against loop devices and scratch mounts.

hb_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
hb_dotfiles=$(cd "$hb_dir/../.." && pwd -P)

HB_USER=${HB_USER:-exedev}
HB_UID=${HB_UID:-1000}
HB_HOSTNAME=${HB_HOSTNAME:-bite-cristian}
# The installed system's root and fstab: / on the box, a scratch mount in test.sh.
HB_TARGET=${HB_TARGET:-}
HB_FSTAB=${HB_FSTAB:-$HB_TARGET/etc/fstab}
HB_HOME=${HB_HOME:-$HB_TARGET/home/$HB_USER}
HB_WORKSPACES=${HB_WORKSPACES:-$HB_TARGET/workspaces}

hb_require_host() {
    local identity=$hb_dir/host-identity.sh
    [[ -r $identity ]] || identity=$hb_dotfiles/workbox/host-identity.sh
    # shellcheck source=../../workbox/host-identity.sh
    . "$identity"
    workbox_require_host
}
# The durable run areas (@runs): run records kept for good, never cleaned, backed up.
HB_RUNS=${HB_RUNS:-$HB_TARGET/runs}
# Mount options of every btrfs line, the same as the exe box's image; user_subvol_rm_allowed: Ergo's work deletes a workspace's subvolume as the user (set by hand on the workbox 2026-11-15).
hb_btrfs_opts=noatime,compress=zstd:3,space_cache=v2,discard=async,user_subvol_rm_allowed
# The subvolumes installimage.conf creates, with their mount points.
hb_subvols="@root:/ @home:/home/$HB_USER @tmp:/tmp @workspaces:/workspaces @runs:/runs"

say() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf '%s: %s\n' "${0##*/}" "$*" >&2; exit 1; }
need() { local c; for c; do command -v "$c" >/dev/null 2>&1 || die "missing command: $c"; done; }
need_root() { [[ $(id -u) == 0 ]] || die "run as root (sudo $0 $*)"; }
gb() { awk -v b="$1" 'BEGIN { printf "%.2f GB", b / 1e9 }'; }

# The device that holds a mount point (findmnt prints [/subvol] after a btrfs
# device; drop it).
mount_source() { findmnt -n -o SOURCE --mountpoint "$1" 2>/dev/null | sed 's/\[.*//'; }
mount_fsroot() { findmnt -n -o FSROOT --mountpoint "$1" 2>/dev/null; }
is_btrfs() { [[ $(findmnt -n -o FSTYPE --mountpoint "$1" 2>/dev/null) == btrfs ]]; }
