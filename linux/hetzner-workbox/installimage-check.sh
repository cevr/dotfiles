#!/usr/bin/env bash
# shellcheck disable=SC2034 # the variables set here are read by the installimage functions
# Runs Hetzner's own config parser and validator (read_vars and validate_vars
# from github.com/hetzneronline/installimage) on installimage.conf, outside the
# Rescue System: DRIVE1 becomes a sparse loop device the size of an AX102
# drive, and the hardware probes and dialogs become stubs. Root, Linux.
# UEFI_MODE=0 validates for a legacy BIOS boot (default 1, UEFI).
#
# Usage: sudo installimage-check.sh <installimage checkout> [config]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd -P)
src=${1:?usage: installimage-check.sh <installimage checkout> [config]}
conf=${2:-$here/installimage.conf}
[[ -f $src/functions.sh ]] || { echo "no installimage checkout at $src" >&2; exit 2; }

work=$(mktemp -d /var/tmp/installimage-check.XXXXXX)
loop=
# installimage defines its own cleanup(); this one has another name.
ic_cleanup() { [[ -z $loop ]] || losetup -d "$loop"; rm -rf "$work"; }
trap ic_cleanup EXIT

# An AX102 drive: 1.92 TB (sparse; nothing is written).
truncate -s 1920383410176 "$work/nvme0n1"
loop=$(losetup --find --show "$work/nvme0n1")
sed "s|^DRIVE1 .*|DRIVE1 $loop|" "$conf" > "$work/install.conf"

FOLD=$work
DEBUGFILE=$work/debug.txt
export FOLD DEBUGFILE
# installimage is not written for set -eu.
set +eu
# shellcheck disable=SC1091
. "$src/config.sh" 2>/dev/null
# shellcheck disable=SC1091
. "$src/functions.sh"
trap ic_cleanup EXIT

# What the Rescue System provides around the functions, defined after them so
# these win.
errors=()
debug() { :; }
debugoutput() { cat >/dev/null; }
graph_error() { errors+=("$*"); printf 'installimage: %b\n' "$*"; }
graph_notice() { printf 'installimage notice: %b\n' "$*"; }
dmidecode() { :; }
hdparm() { :; }
is_usb_disk() { return 1; }
is_cpanel_install() { return 1; }
is_plesk_install() { return 1; }
is_dell_r6415() { return 1; }
getHDDsNotInToleranceRange() { :; }
check_dos_partitions() { :; }
image_requires_xfs_version_check() { return 1; }
# getdrives counts every disk of this host; DRIVE1 is the only one named.
getdrives() { COUNT_DRIVES=1; }
wd=$work
# The target is an amd64 server, booted either way.
SYSARCH=amd64
UEFI=${UEFI_MODE:-1}

rc=0
validate_vars "$work/install.conf" || rc=$?
if ((rc != 0 || ${#errors[@]} > 0)); then
    echo "installimage-check: FAIL (validate_vars $rc)"
    exit 1
fi
printf 'installimage-check: ok (UEFI=%s): %s partitions, %s btrfs subvolumes, image %s (%s %s), hostname %s\n' \
    "$UEFI" "$PART_COUNT" "$BTRFS_SV_COUNT" "$IMAGE_FILE" "$IAM" "$IMG_VERSION" "$NEWHOSTNAME"
