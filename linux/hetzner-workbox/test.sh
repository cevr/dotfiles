#!/usr/bin/env bash
# Runs the Hetzner workbox scripts end to end in a scratch world on a Linux VM:
#
#   1. installimage-check.sh: Hetzner's own validator on installimage.conf
#      (UEFI and BIOS), and on a broken copy, which it must refuse;
#   2. two loop "NVMe drives", the first laid out as installimage leaves it
#      (ESP, /boot, swap, one btrfs with @root @home @tmp @workspaces), then
#      layout.sh (raid1, mdraid1 /boot and swap, the second ESP, simple quotas), twice;
#   3. provision.sh's user, keys, packages, storage, sshd, upgrades and sysctl phases,
#      twice, then ssh into the test sshd with a test key and sudo;
#   3a. storage.sh (storage.conf with MiB for GiB): each subvolume, owner, mode and
#      limit; a write past a limit fails with EDQUOT and nothing else is affected; the
#      caches' group; a directory holding files is left; a boot (tmpfiles) empties
#      /tmp and the storage unit's apply makes /tmp/opencode again;
#   3b. workbox/system-tools.sh for real (provision.sh tools and reserve): the
#      shells and qemu-user-static installed and registered, twice; Go and
#      PowerShell refused on a VM that is not amd64, then, with dpkg saying amd64,
#      into a scratch root: go.dev's real tarball against the pin (its go runs
#      through the qemu binfmt entry) and Microsoft's real key against the
#      pinned fingerprint, apt verifying the repository with it and fetching the
#      amd64 powershell package; the reserve drop-ins and their cgroup values,
#      a transient opencode-service scope's too; the run families' slices (a run
#      placed by the user lands in its family with its values, two CPU-bound runs
#      share near 5:1 by weight, ssh still answers); /tmp's cleaner keeps what a
#      process holds; the free-space figures. The packages it adds to the VM and
#      the binfmt entry it registers go again at the end;
#   4. sync.sh from a scratch "exe box" btrfs (a home with hard links,
#      reflinks, xattrs and a nested subvolume; /workspaces with a warm source,
#      Rifts and a read-only snapshot): dry run, pass 1, changes, pass 2, rest,
#      activate; then the target's trees must equal the source's, Rifts must
#      share extents with their source, and the dry runs must count bytes; the
#      caches stay behind, and the boot after makes them empty limited subvolumes;
#   4b. a lane's life as the user: snapshot, its exclusive bytes read unprivileged
#      before and after 100 MiB, rename into a trash dir, delete;
#   5. backup.sh run twice into a local "Storage Box" directory, restore;
#   6. check.sh, and workbox-rift-storage --check on a native line;
#   7. 200 snapshots made and deleted, timed, quotas off and simple.
#
# Root on a scratch Linux VM (sudo). It creates and removes: loop devices,
# md arrays named hbt-*, a user hbtest (uid 1990), the units and files
# provision.sh installs, and its own directory under /var/tmp.
#
# Its cleanup removes every run's leftovers, not only its own: it runs at the
# start of a run and at its exit, and alone with --cleanup (a run cut short by
# a VM restart skips its exit). Each item is removed only if present, so it is
# idempotent.
#
# While it runs, a sampler writes memory, pressure and the largest processes
# every 3 s, and the kernel's warnings, to the serial console (/dev/hvc0, which
# Lima keeps in serialv.log on the host) and to /dev/shm: a run that hangs the
# guest still leaves its last samples outside it. The run prints the peaks.
#
# Usage: sudo test.sh <installimage checkout>
#        sudo test.sh --cleanup
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd -P)
[[ $(uname -s) == Linux && $(id -u) == 0 ]] || { echo 'test.sh: Linux and root' >&2; exit 2; }
user=hbtest uid=1990
prefix=/var/tmp/hetzner-workbox-test.
samples=/dev/shm/hetzner-workbox-test.samples
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'ok: %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

# Step 3b's additions to the VM itself, from what each run recorded in its directory: the packages
# that were not here before it (pkgs-before), the binfmt entry it registered (binfmt-registered).
# The files system-tools.sh's reserve, slices and tmp steps and provision.sh's storage phase put in the
# VM's own /etc and /usr/local (the VM had none of them before: 2026-11-23).
tools_files=(
    /etc/systemd/{system/user.slice.d,system/user-.slice.d,system/user@.service.d,user/app.slice.d,user/opencode-service-.scope.d}/30-workbox-reserve.conf
    /etc/systemd/user/{opencode,ergo,bite-work,personal}.slice
    /etc/systemd/system/{user.slice.d,system.slice.d}/40-workbox-slices.conf
    /etc/systemd/system/user@.service.d/40-workbox-delegate.conf
    /etc/tmpfiles.d/tmp.conf /usr/local/sbin/workbox-tmp-clean
    /etc/systemd/system/systemd-tmpfiles-clean.service.d/30-workbox-held.conf
    /etc/systemd/system/hetzner-workbox-storage.service
)
cleanup_tools() {
    local d f new
    systemctl disable hetzner-workbox-storage.service >/dev/null 2>&1
    for f in "${tools_files[@]}"; do
        rm -f "$f"
        [[ $(dirname "$f") == *.d ]] && rmdir "$(dirname "$f")" 2>/dev/null
    done
    for d in "$prefix"*; do
        if [[ -f $d/pkgs-before ]]; then
            new=$(comm -13 "$d/pkgs-before" <(dpkg-query -W -f='${Package}\n' | sort -u))
            # shellcheck disable=SC2086 # a word list
            [[ -n $new ]] && NEEDRESTART_SUSPEND=1 DEBIAN_FRONTEND=noninteractive apt-get purge -y -q $new >/dev/null 2>&1
        fi
        if [[ -f $d/binfmt-registered ]]; then
            f=/proc/sys/fs/binfmt_misc/qemu-$(cat "$d/binfmt-registered")
            [[ -e $f ]] && printf -- '-1' > "$f"
        fi
    done
    systemctl daemon-reload
}

cleanup() {
    set +e
    local l s m md h
    systemctl stop hbtest-sampler.service >/dev/null 2>&1
    if [[ -n ${tools_scope:-} ]] && id "$user" >/dev/null 2>&1; then
        runuser -u "$user" -- env XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user stop "$tools_scope" >/dev/null 2>&1
    fi
    cleanup_tools
    systemctl disable --now bite-workbox-sshd.service >/dev/null 2>&1
    rm -f /etc/systemd/system/bite-workbox-sshd.service /etc/systemd/system/bite.slice \
        /etc/ssh/bite-workbox-sshd_config /etc/ssh/bite-workbox-ssh-host-ed25519-key \
        /etc/ssh/bite-workbox-ssh-host-ed25519-key.pub "/etc/sudoers.d/90-$user" /etc/sysctl.d/90-inotify.conf
    systemctl daemon-reload
    systemctl stop bite.slice >/dev/null 2>&1
    for s in $(awk 'NR > 1 { print $1 }' /proc/swaps); do
        case $(readlink -f "$s") in /dev/md* | /dev/loop*) swapoff "$s" ;; esac
    done
    for m in $(findmnt -rn -o TARGET | grep -E "^(${prefix//./\\.}|/var/lib/hetzner-sync/top)" | sort -r); do umount "$m" || umount -l "$m"; done
    for md in /dev/md/hbt-*; do [[ -e $md ]] && mdadm --stop "$md" >/dev/null 2>&1; done
    udevadm settle
    # The loop devices backed by any run's files. A stopped array's members can stay busy for a
    # moment; udev may also assemble them again, so stop whatever holds a loop partition.
    for l in $(losetup -n -l -O NAME,BACK-FILE | awk -v p="$prefix" 'index($2, p) == 1 { print $1 }'); do
        for h in /sys/block/"${l##*/}"/"${l##*/}"p*/holders/md*; do
            [[ -e $h ]] && mdadm --stop "/dev/${h##*/}" >/dev/null 2>&1
        done
        for _ in 1 2 3 4 5; do losetup -d "$l" 2>/dev/null && break; sleep 1; done
    done
    btrfs device scan --forget >/dev/null 2>&1
    if id "$user" >/dev/null 2>&1; then
        loginctl disable-linger "$user"
        systemctl stop "user@$uid.service" 2>/dev/null
        loginctl terminate-user "$user" 2>/dev/null
        # The user manager's last process (sd-pam) can outlive its unit by a moment.
        for _ in 1 2 3 4 5; do
            pkill -KILL -u "$user" 2>/dev/null
            userdel "$user" 2>/dev/null && break
            sleep 1
        done
    fi
    rm -rf "$prefix"*
}

# Fails, naming what is left, unless the cleanup removed every item a run makes.
check_clean() {
    local left=()
    compgen -G "$prefix*" >/dev/null && left+=("$(ls -d "$prefix"*)")
    [[ -n $(losetup -n -l -O NAME,BACK-FILE | awk -v p="$prefix" 'index($2, p) == 1') ]] && left+=("loop devices")
    compgen -G '/dev/md/hbt-*' >/dev/null && left+=("md arrays hbt-*")
    id "$user" >/dev/null 2>&1 && left+=("user $user")
    local f
    for f in "${tools_files[@]}"; do [[ -e $f ]] && left+=("$f"); done
    systemctl is-active --quiet hbtest-sampler.service && left+=("the sampler")
    [[ -e /etc/systemd/system/bite.slice || -e /etc/systemd/system/bite-workbox-sshd.service ]] && left+=("units")
    ((${#left[@]} == 0)) || fail "left after cleanup: ${left[*]}"
}

if [[ ${1:-} == --cleanup ]]; then
    cleanup
    rm -f "$samples"
    check_clean
    pass "nothing left of earlier runs"
    exit 0
fi
installimage_src=${1:?usage: test.sh <installimage checkout> | test.sh --cleanup}

# A run cut short (a VM restart skips the exit trap) left its things: remove them first.
(cleanup) >/dev/null 2>&1
check_clean
trap cleanup EXIT

work=$(mktemp -d "${prefix}XXXXXX")
# The test user's home is under it, and sshd reads authorized_keys as that user.
chmod 755 "$work"
T=$work/target S=$work/source
loops=()
tools_scope=''

# The sampler: MemAvailable, the memory and IO pressure (some, avg10), dirty and writeback pages,
# and the three largest processes, every 3 s; the kernel's warnings as they come. A unit of its own
# (hbtest-sampler.service), so nothing the test does to its own processes or the test user's ends it;
# the cleanup stops it.
console=/dev/null
[[ -w /dev/hvc0 ]] && console=/dev/hvc0
: > "$samples"
# shellcheck disable=SC2016 # the sampler's own script
systemd-run --quiet --collect --unit=hbtest-sampler bash -c '
    samples=$1 console=$2
    dmesg -w --level=emerg,alert,crit,err,warn > "$console" 2>/dev/null &
    while :; do
        line="hb-sample $(date +%T) avail_mb=$(awk "/^MemAvailable/ { print int(\$2 / 1024) }" /proc/meminfo)"
        line+=" mem_some=$(awk -F"[ =]" "/^some/ { print \$3 }" /proc/pressure/memory)"
        line+=" io_some=$(awk -F"[ =]" "/^some/ { print \$3 }" /proc/pressure/io)"
        line+=" dirty_mb=$(awk "/^Dirty:/ { print int(\$2 / 1024) }" /proc/meminfo)"
        line+=" writeback_mb=$(awk "/^Writeback:/ { print int(\$2 / 1024) }" /proc/meminfo)"
        line+=" top=$(ps -eo rss=,comm= --sort=-rss | head -n 3 | awk "{ printf \"%s:%dM,\", \$2, \$1 / 1024 }")"
        printf "%s\n" "$line" >> "$samples"
        timeout 1 sh -c "printf \"%s\\r\\n\" \"\$1\" > \"\$2\"" _ "$line" "$console" 2>/dev/null
        sleep 3
    done' sampler "$samples" "$console"

new_loop() { # size file -> sets loop to a loop device with partitions (not in a subshell, so cleanup sees it)
    truncate -s "$1" "$2"
    loop=$(losetup --find --show --partscan "$2")
    loops+=("$loop")
}
as_user() { runuser -u "$user" -- "$@"; }

# ------------------------------------------------------------------ 1
step "installimage.conf against Hetzner's validator"
UEFI_MODE=1 bash "$here/installimage-check.sh" "$installimage_src" | tail -n 1 | grep -q '^installimage-check: ok' ||
    fail "installimage.conf (UEFI) is refused"
pass "installimage.conf passes validate_vars, UEFI"
UEFI_MODE=0 bash "$here/installimage-check.sh" "$installimage_src" | tail -n 1 | grep -q '^installimage-check: ok' ||
    fail "installimage.conf (BIOS) is refused"
pass "installimage.conf passes validate_vars, legacy BIOS"
sed 's/^PART btrfs\.1 .*/&\nPART \/data ext4 10G/' "$here/installimage.conf" > "$work/bad.conf"
if bash "$here/installimage-check.sh" "$installimage_src" "$work/bad.conf" >/dev/null 2>&1; then
    fail "the validator accepted a config with a partition after 'all'"
fi
pass "the validator refuses a broken config"

# ------------------------------------------------------------------ 2
step "installimage's layout on drive 1, then layout.sh"
new_loop 3G "$work/nvme0"; d1=$loop
new_loop 3G "$work/nvme1"; d2=$loop
printf 'label: gpt\n,64M,U\n,128M,L\n,64M,S\n,,L\n' | sfdisk -q "$d1"
udevadm settle
mkfs.vfat -F 32 -n EFI "${d1}p1" >/dev/null
mkfs.ext4 -q -L boot "${d1}p2"
mkswap -q "${d1}p3"
mkfs.btrfs -q -f "${d1}p4"
mkdir -p "$work/top" "$T"
mount "${d1}p4" "$work/top"
for sv in @root @home @tmp @workspaces; do btrfs subvolume create "$work/top/$sv" >/dev/null; done
btrfs subvolume set-default 256 "$work/top"
umount "$work/top"
mount -o subvol=@root "${d1}p4" "$T"
mkdir -p "$T/boot" "$T/home/$user" "$T/tmp" "$T/workspaces" "$T/etc"
mount "${d1}p2" "$T/boot"
mkdir -p "$T/boot/efi"
mount "${d1}p1" "$T/boot/efi"
mount -o subvol=@home "${d1}p4" "$T/home/$user"
mount -o subvol=@tmp "${d1}p4" "$T/tmp"
mount -o subvol=@workspaces "${d1}p4" "$T/workspaces"
swapon "${d1}p3"
echo kernel > "$T/boot/vmlinuz-test"
mkdir -p "$T/boot/efi/EFI/ubuntu"
echo grub > "$T/boot/efi/EFI/ubuntu/grubx64.efi"
# The fstab installimage writes (create_btrfs_subvolumes and make_fstab_entry).
{
    printf 'proc /proc proc defaults 0 0\n'
    printf '%sp1 /boot/efi vfat umask=0077 0 1\n' "$d1"
    printf '%sp2 /boot ext4 defaults 0 0\n' "$d1"
    printf '%sp3 none swap sw 0 0\n' "$d1"
    for pair in @root:/ @home:/home/$user @tmp:/tmp @workspaces:/workspaces; do
        printf '%sp4 %s btrfs defaults,subvol=%s 0 0\n' "$d1" "${pair#*:}" "${pair%%:*}"
    done
} > "$T/etc/fstab"
export HB_TARGET=$T HB_USER=$user HB_UID=$uid HB_DISK1=$d1 HB_DISK2=$d2 HB_BOOTLOADER=0 HB_MD_PREFIX=hbt-

before=$(sha256sum "$T/etc/fstab")
bash "$here/layout.sh" --dry-run > "$work/layout-dry.log"
[[ $(sha256sum "$T/etc/fstab") == "$before" && -z $(lsblk -nr -o TYPE "$d2" | grep part || true) ]] || fail "layout.sh --dry-run changed something"
grep -q 'would run: sfdisk' "$work/layout-dry.log" || fail "layout.sh --dry-run did not name the partition copy"
pass "layout.sh --dry-run changes nothing"

bash "$here/layout.sh" > "$work/layout-1.log" || { cat "$work/layout-1.log"; fail "layout.sh"; }
mdadm --wait /dev/md/hbt-boot /dev/md/hbt-swap >/dev/null 2>&1 || true
bash "$here/layout.sh" > "$work/layout-2.log" || { cat "$work/layout-2.log"; fail "layout.sh rerun"; }
grep -E 'adding|mirroring|converting|formatting' "$work/layout-2.log" && fail "layout.sh's rerun changed something"
pass "layout.sh rerun only checks"
[[ $(btrfs filesystem show "$T" | grep -c ' path ') == 2 ]] || fail "btrfs is not on two devices"
btrfs filesystem df "$T" | grep -E '^(Data|Metadata|System)' | grep -v RAID1 && fail "a btrfs profile is not raid1"
pass "btrfs raid1 on ${d1}p4 and ${d2}p4"
[[ -f $T/boot/vmlinuz-test && $(readlink -f "$(findmnt -n -o SOURCE --mountpoint "$T/boot")") == /dev/md* ]] || fail "/boot is not the md copy"
pass "/boot on mdraid1, files copied"
grep -qE '^UUID=[^ ]+ /boot ext4' "$T/etc/fstab" || fail "fstab /boot line not switched"
grep -qE '^UUID=[^ ]+ none swap' "$T/etc/fstab" || fail "fstab swap line not switched"
[[ $(awk '$3 == "btrfs"' "$T/etc/fstab" | grep -c 'subvol=@[a-z]*,noatime,compress=zstd:3,.*user_subvol_rm_allowed') == 4 ]] || fail "fstab btrfs options"
awk '$3 == "btrfs" && $1 !~ /^UUID=/ { exit 1 }' "$T/etc/fstab" || fail "a btrfs fstab line names a device, not the UUID"
pass "fstab: /boot and swap by md UUID, btrfs by UUID with the options"
mkdir -p "$work/esp2"
mount "${d2}p1" "$work/esp2"
[[ -f $work/esp2/EFI/ubuntu/grubx64.efi ]] || fail "the second ESP lacks the copy"
umount "$work/esp2"
pass "second ESP holds the copy"
[[ $(grep -c '^ARRAY' "$T/etc/mdadm/mdadm.conf") == 2 ]] ||
    { cat "$T/etc/mdadm/mdadm.conf"; ls -l /dev/md/; fail "mdadm.conf lacks the arrays"; }
[[ $(stat -c %a "$T/tmp") == 1777 ]] || fail "/tmp mode"
pass "mdadm.conf, /tmp 1777"
qgroups=/sys/fs/btrfs/$(findmnt -n -o UUID -T "$T/workspaces")/qgroups
[[ $(cat "$qgroups/mode") == squota ]] || fail "layout.sh did not turn on simple quotas: $(cat "$qgroups/mode" 2>&1)"
grep -q '^ok: simple quotas are on' "$work/layout-2.log" || { cat "$work/layout-2.log"; fail "layout.sh's rerun did not find simple quotas on"; }
pass "layout.sh turned on btrfs simple quotas (mode $(cat "$qgroups/mode")); its rerun finds them on"
# The test's swap is an md mirror of loop devices backed by files on the VM's own disk. Swap
# through a loop device on a journaling file system can deadlock the guest once the kernel writes
# pages to it (2026-11-22, twice: jbd2/vda1, md126_raid1, kworkers and apt-get blocked for minutes,
# MemAvailable 1.4 GB, serial console). layout.sh's swap is checked above; it is off until check.sh.
swap_off_test() {
    local s
    for s in $(awk 'NR > 1 { print $1 }' /proc/swaps); do
        case $(readlink -f "$s") in /dev/md* | /dev/loop*) swapoff "$s" ;; esac
    done
}
swap_off_test

# ------------------------------------------------------------------ 3
step "provision.sh"
ssh-keygen -q -t ed25519 -N '' -C hb-test -f "$work/id_test"
export HB_APT_REPOS=0 HB_PACKAGES="btrbk sshfs mdadm rsync zstd attr" HB_SSH_LISTEN=127.0.0.1 HB_SSH_PORT=2299
# storage.conf as it is, each limit in MiB where it says GiB: small enough to fill here. storage.sh's
# copies go to a scratch lib (the box's is /usr/local/lib/hetzner-workbox).
sed -E -e 's/^((scratch|cache)[[:space:]]+[^[:space:]]+[[:space:]]+[0-9]+)G/\1M/' \
    -e 's/^(qgroup[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+[0-9]+)G/\1M/' "$here/storage.conf" > "$work/storage.conf"
grep -E '^(scratch|cache|qgroup)' "$work/storage.conf" | grep -q '[0-9]G' && fail "the scaled storage.conf still has a GiB limit"
export HB_STORAGE_CONF=$work/storage.conf HB_LIB=$work/lib
HB_EXTRA_KEYS=$(cat "$work/id_test.pub") bash "$here/provision.sh" user keys packages storage sshd upgrades sysctl > "$work/prov-1.log" ||
    { cat "$work/prov-1.log"; fail "provision.sh"; }
HB_EXTRA_KEYS=$(cat "$work/id_test.pub") bash "$here/provision.sh" user keys packages storage sshd upgrades sysctl > "$work/prov-2.log" ||
    { cat "$work/prov-2.log"; fail "provision.sh rerun"; }
grep -E '^==> (installed|installing|user |make |remove |limit |join |owner |mode )' "$work/prov-2.log" && fail "provision.sh's rerun changed something"
grep -q 'authorized_keys: 0 added, 3 in all' "$work/prov-2.log" || { cat "$work/prov-2.log"; fail "authorized_keys"; }
pass "provision.sh rerun changes nothing; authorized_keys holds the Mac, herdr-mobile and the extra key"
[[ $(id -u "$user") == "$uid" && $(stat -c %U "$T/home/$user") == "$user" && $(stat -c %U "$T/workspaces") == "$user" ]] || fail "user, home, /workspaces"
loginctl show-user "$user" -p Linger | grep -q yes || fail "linger"
out=$(ssh -p 2299 -i "$work/id_test" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null "$user@127.0.0.1" 'id -u; sudo -n true && echo sudo-ok' 2>"$work/ssh.err") ||
    { cat "$work/ssh.err"; journalctl -u bite-workbox-sshd -n 20 --no-pager; fail "ssh into the test sshd"; }
[[ $out == "$uid"$'\n'sudo-ok ]] || fail "ssh session: $out"
pass "sshd on 127.0.0.1:2299 lets $user in by key; sudo without a password"
ss -ltn 'sport = :2299' | grep -q '127.0.0.1:2299' && ! ss -ltn 'sport = :2299' | grep -q '0.0.0.0:2299' || fail "sshd listens beyond its address"
nft -c -f "$here/firewall.nft" || fail "firewall.nft does not parse"
pass "firewall.nft parses"
grep -qx 'APT::Periodic::Unattended-Upgrade "1";' /etc/apt/apt.conf.d/20auto-upgrades || fail "unattended upgrades"
pass "unattended upgrades on"
[[ $(sysctl -n fs.inotify.max_user_watches) -ge 4194304 && $(sysctl -n fs.inotify.max_user_instances) -ge 1024 ]] || fail "inotify limits"
pass "inotify limits raised"
bash "$here/provision.sh" bootstrap | grep -q 'the home has no dotfiles yet' || fail "bootstrap phase before the sync"
pass "bootstrap phase waits for the synced home"

# ------------------------------------------------------------------ 3a
step "storage.sh: the limited subvolumes (storage.conf, limits in MiB here)"
qgroup_of() { echo "$qgroups/0_$(btrfs inspect-internal rootid "$1")"; }
box() { # a storage.conf path -> its path in the target
    case $1 in "~"*) echo "$T/home/$user${1#"~"}" ;; /workspaces*) echo "$T/workspaces${1#/workspaces}" ;; *) echo "$T$1" ;; esac
}
# Random data: the file systems compress, and a quota counts what is on disk.
fill() { # file MiB -> fails as dd does (EDQUOT: "Disk quota exceeded" in $work/dd.err)
    dd if=/dev/urandom of="$1" bs=1M count="$2" conv=fsync status=none 2>"$work/dd.err"
}
while read -r _ path limit owner mode group; do
    p=$(box "$path")
    [[ -d $p && $(stat -c %i "$p") == 256 ]] || fail "$path ($p) is not a subvolume"
    [[ $(cat "$(qgroup_of "$p")/max_referenced") == $((${limit%M} << 20)) ]] || fail "$path: limit $(cat "$(qgroup_of "$p")/max_referenced"), want $limit"
    want=root
    [[ $owner == user ]] && want=$user
    [[ $(stat -c %U "$p") == "$want" ]] || fail "$path belongs to $(stat -c %U "$p"), want $want"
    [[ $mode == - || $(stat -c %a "$p") == "${mode#0}" ]] || fail "$path mode $(stat -c %a "$p"), want $mode"
    if [[ $group != - ]]; then
        btrfs qgroup show -p --raw "$T/workspaces" | awk -v q="0/$(btrfs inspect-internal rootid "$p")" '$1 == q' | grep -q '1/100' ||
            fail "$path is not in qgroup 1/100"
    fi
done < <(sed -e 's/#.*//' "$work/storage.conf" | grep -E '^(scratch|cache)')
for d in .cache go go/pkg .bun .bun/install; do
    [[ $(stat -c %U "$T/home/$user/$d") == "$user" ]] || fail "the home's $d was made as $(stat -c %U "$T/home/$user/$d"), not $user"
done
[[ $(cat "$qgroups/1_100/max_referenced") == $((150 << 20)) ]] || fail "qgroup 1/100 limit"
bash "$HB_LIB/storage.sh" check > "$work/storage-check.log" 2>&1 || { cat "$work/storage-check.log"; fail "storage.sh check"; }
pass "each storage.conf line is a subvolume with its owner, mode and limit; the caches' parents made as $user; storage.sh check passes"

# A write past a limit fails with EDQUOT in that subvolume; the rest of the volume takes writes.
if fill "$T/tmp/opencode/past" 150; then fail "150 MiB went into /tmp/opencode, limit 100 MiB"; fi
grep -q 'Disk quota exceeded' "$work/dd.err" || { cat "$work/dd.err"; fail "/tmp/opencode's refusal was not EDQUOT"; }
fill "$T/tmp/beside" 20 || { cat "$work/dd.err"; fail "/tmp refused a write while /tmp/opencode was full"; }
fill "$T/workspaces/beside" 20 || { cat "$work/dd.err"; fail "/workspaces refused a write while /tmp/opencode was full"; }
rm -f "$T/tmp/opencode/past" "$T/tmp/beside" "$T/workspaces/beside"
# The caches' group: each member under its own limit, together past the group's 150 MiB.
fill "$T/workspaces/.cache/ergo-gocache/a" 90 || { cat "$work/dd.err"; fail "90 MiB into ergo-gocache (100)"; }
fill "$T/workspaces/.cache/unlisted" 50 || { cat "$work/dd.err"; fail "50 MiB into .cache (60)"; }
if fill "$T/workspaces/.cache/turbo/c" 20; then fail "the caches' group took 160 MiB, limit 150"; fi
grep -q 'Disk quota exceeded' "$work/dd.err" || { cat "$work/dd.err"; fail "the group's refusal was not EDQUOT"; }
rm -f "$T/workspaces/.cache/ergo-gocache/a" "$T/workspaces/.cache/unlisted" "$T/workspaces/.cache/turbo/c"
btrfs filesystem sync "$T/workspaces"
pass "a write past a limit fails with EDQUOT (Disk quota exceeded) and the rest of the volume takes writes; the caches' group caps its members together"

# storage.sh deletes nothing: a directory holding files where a subvolume belongs is named and left;
# an empty one becomes the subvolume.
mkdir -p "$T/workspaces/held-cache" "$T/workspaces/empty-cache"
echo keep > "$T/workspaces/held-cache/f"
cp "$work/storage.conf" "$work/storage-held.conf"
printf 'cache /workspaces/held-cache 10M user 0755 -\ncache /workspaces/empty-cache 10M user 0755 -\n' >> "$work/storage-held.conf"
if HB_STORAGE_CONF=$work/storage-held.conf bash "$HB_LIB/storage.sh" apply > "$work/storage-held.log" 2>&1; then fail "storage.sh apply passed over a directory holding files"; fi
grep -q 'held-cache holds files and is not a subvolume: left as it is' "$work/storage-held.log" || { cat "$work/storage-held.log"; fail "the held directory was not named"; }
[[ $(cat "$T/workspaces/held-cache/f") == keep && $(stat -c %i "$T/workspaces/empty-cache") == 256 ]] || fail "held-cache or empty-cache"
rm -rf "$T/workspaces/held-cache"
btrfs subvolume delete "$T/workspaces/empty-cache" >/dev/null
pass "a directory holding files is named and left; an empty one becomes the subvolume"

# A boot: tmpfiles (workbox/systemd/tmp/tmpfiles.d/tmp.conf's D lines, here on the target's /tmp)
# empties /tmp and /tmp/opencode's contents and keeps /tmp/opencode's subvolume, so its limit stays;
# hetzner-workbox-storage.service's apply then finds it in place. A first boot, with no /tmp/opencode:
# tmpfiles makes a plain directory as the user, which the apply replaces with the subvolume.
grep -v '/var/tmp' "$here/../../workbox/systemd/tmp/tmpfiles.d/tmp.conf" | sed -e "s|/tmp|$T/tmp|" -e "s/exedev/$user/g" > "$work/boot-tmp.conf"
echo run > "$T/tmp/opencode/run-file"
echo left > "$T/tmp/left"
systemd-tmpfiles --remove --create "$work/boot-tmp.conf" 2>&1 | grep -v '^$' || true
[[ $(ls -A "$T/tmp") == opencode && -z $(ls -A "$T/tmp/opencode") && $(stat -c %a "$T/tmp") == 1777 ]] ||
    fail "the boot's tmpfiles did not empty /tmp: $(find "$T/tmp" | tr '\n' ' ')"
[[ $(stat -c %i "$T/tmp/opencode") == 256 && $(stat -c %U "$T/tmp/opencode") == "$user" &&
    $(cat "$(qgroup_of "$T/tmp/opencode")/max_referenced") == $((100 << 20)) ]] || fail "/tmp/opencode after the boot"
bash "$HB_LIB/storage.sh" apply > "$work/boot-storage.log" 2>&1 || { cat "$work/boot-storage.log"; fail "storage.sh apply after the boot"; }
grep '^==>' "$work/boot-storage.log" && fail "storage.sh apply changed something after a boot"
btrfs subvolume delete "$T/tmp/opencode" >/dev/null
systemd-tmpfiles --remove --create "$work/boot-tmp.conf" 2>&1 | grep -v '^$' || true
[[ -d $T/tmp/opencode && $(stat -c %i "$T/tmp/opencode") != 256 && $(stat -c %U "$T/tmp/opencode") == "$user" ]] ||
    fail "a first boot's tmpfiles did not make /tmp/opencode as $user"
bash "$HB_LIB/storage.sh" apply > "$work/boot-storage-2.log" 2>&1 || { cat "$work/boot-storage-2.log"; fail "storage.sh apply after a first boot"; }
[[ $(stat -c %i "$T/tmp/opencode") == 256 && $(stat -c %U "$T/tmp/opencode") == "$user" &&
    $(cat "$(qgroup_of "$T/tmp/opencode")/max_referenced") == $((100 << 20)) ]] || fail "/tmp/opencode after a first boot"
systemctl is-enabled --quiet hetzner-workbox-storage.service || fail "hetzner-workbox-storage.service is not enabled"
pass "a boot empties /tmp and /tmp/opencode, whose subvolume and limit stay; on a first boot the storage unit (enabled) makes it a limited subvolume"

# ------------------------------------------------------------------ 3b
step "system-tools.sh (workbox/pins.conf), for real"
tools=$here/../../workbox/system-tools.sh
pin() { sed -n "s/^$1=//p" "$here/../../workbox/pins.conf"; }
arch=$(dpkg --print-architecture)
case $arch in amd64) tools_foreign=aarch64 ;; arm64) tools_foreign=x86_64 ;; *) fail "a $arch VM" ;; esac
# For the cleanup: the packages here before, and the binfmt entry if this run registers it.
dpkg-query -W -f='${Package}\n' | sort -u > "$work/pkgs-before"
[[ -e /proc/sys/fs/binfmt_misc/qemu-$tools_foreign ]] || printf '%s\n' "$tools_foreign" > "$work/binfmt-registered"
if [[ $arch == amd64 ]]; then
    # An amd64 VM would take the real Go and PowerShell into its own /usr/local and apt: the shells
    # and qemu only here; the scratch-root runs below still cover Go and PowerShell.
    bash "$tools" shells qemu > "$work/tools-1.log" 2>&1 || { cat "$work/tools-1.log"; fail "system-tools.sh shells qemu"; }
    pass "amd64 VM: the arch refusal is not exercised here (system-tools.test.ts covers it)"
else
    # provision.sh's tools phase: the shells and qemu install, then Go refuses this architecture.
    if bash "$here/provision.sh" tools > "$work/tools-1.log" 2>&1; then cat "$work/tools-1.log"; fail "provision.sh tools passed on $arch"; fi
    grep -q "this host is $arch: refusing" "$work/tools-1.log" || { cat "$work/tools-1.log"; fail "provision.sh tools failed for another reason"; }
    [[ ! -e /usr/local/go-$(pin GO_VERSION) ]] || fail "a refused Go left a tree"
    if bash "$tools" pwsh > "$work/pwsh-arch.log" 2>&1; then fail "pwsh passed on $arch"; fi
    grep -q "this host is $arch: refusing" "$work/pwsh-arch.log" || { cat "$work/pwsh-arch.log"; fail "pwsh failed for another reason"; }
    [[ ! -e /usr/share/keyrings/microsoft-prod.gpg ]] || fail "a refused pwsh left a keyring"
    pass "$arch: Go and PowerShell refused, nothing installed"
fi
bash "$tools" shells qemu > "$work/tools-2.log" 2>&1 || { cat "$work/tools-2.log"; fail "system-tools.sh shells qemu, rerun"; }
grep '^==>' "$work/tools-2.log" && fail "system-tools.sh's rerun changed something"
for c in fish ksh mksh; do command -v "$c" >/dev/null || fail "$c is not on PATH"; done
if ! grep -qx enabled "/proc/sys/fs/binfmt_misc/qemu-$tools_foreign" || ! grep -q '^flags: .*F' "/proc/sys/fs/binfmt_misc/qemu-$tools_foreign"; then
    fail "binfmt qemu-$tools_foreign is not enabled with F"
fi
pass "fish, ksh, mksh, qemu-user-static; binfmt qemu-$tools_foreign enabled with F; the rerun changes nothing"

# Go and PowerShell for amd64, into a scratch root: dpkg says amd64; apt-get and dpkg-query use a
# scratch apt for the scratch root's Microsoft source, amd64 only, and `apt-get install` downloads.
R=$work/tools-root A=$work/tools-apt
mkdir -p "$R/etc/apt/sources.list.d" "$A/bin" "$A/parts" "$A/lists/partial" "$A/cache/archives/partial" "$A/debs"
cp /etc/os-release "$R/etc/os-release"
# The VM is not the box's release: name noble, the AX102's (installimage.conf).
sed -i -e 's/^VERSION_ID=.*/VERSION_ID="24.04"/' -e 's/^VERSION_CODENAME=.*/VERSION_CODENAME=noble/' "$R/etc/os-release"
: > "$A/status"
printf '#!/bin/sh\necho amd64\n' > "$A/bin/dpkg"
# shellcheck disable=SC2016 # the shim's own variables
printf '%s\n' '#!/bin/sh' \
    'for last; do :; done' \
    '[ "$last" = powershell ] || exec /usr/bin/dpkg-query "$@"' \
    'ls "$WB_APT"/debs/powershell_*_amd64.deb >/dev/null 2>&1 && printf "ii "' \
    'exit 0' > "$A/bin/dpkg-query"
# shellcheck disable=SC2016 # the shim's own variables
printf '%s\n' '#!/bin/sh' \
    'set -e' \
    'sed "s|signed-by=/usr/share|signed-by=$WORKBOX_TOOLS_ROOT/usr/share|" "$WORKBOX_TOOLS_ROOT/etc/apt/sources.list.d/microsoft-prod.list" > "$WB_APT/sources.list"' \
    'o="-o Dir::Etc::SourceList=$WB_APT/sources.list -o Dir::Etc::SourceParts=$WB_APT/parts -o Dir::State::Lists=$WB_APT/lists -o Dir::Cache=$WB_APT/cache -o Dir::State::status=$WB_APT/status -o APT::Architecture=amd64 -o APT::Architectures=amd64"' \
    'command=' \
    'while [ "$#" -gt 0 ]; do' \
    '  case $1 in -o) o="$o -o $2"; shift 2 ;; -*) shift ;; *) [ -n "$command" ] || command=$1; shift ;; esac' \
    'done' \
    'case $command in' \
    '  update) /usr/bin/apt-get $o update -q ;;' \
    '  install) cd "$WB_APT/debs" && /usr/bin/apt-get $o download powershell ;;' \
    '  *) echo "apt-get shim: $command is not update or install" >&2; exit 1 ;;' \
    'esac' > "$A/bin/apt-get"
chmod +x "$A/bin/"*
amd64() { env PATH="$A/bin:$PATH" WB_APT="$A" WORKBOX_TOOLS_ROOT="$R" bash "$tools" "$@"; }
amd64 go pwsh > "$work/amd64-1.log" 2>&1 || { cat "$work/amd64-1.log"; fail "system-tools.sh go pwsh (amd64, scratch root)"; }
amd64 go pwsh > "$work/amd64-2.log" 2>&1 || { cat "$work/amd64-2.log"; fail "system-tools.sh go pwsh, rerun"; }
grep '^==>' "$work/amd64-2.log" && fail "go pwsh rerun changed something"
[[ $(readlink "$R/usr/local/go") == go-$(pin GO_VERSION) && $(cat "$R/usr/local/go/.workbox-sha256") == "$(pin GO_SHA256)" ]] || fail "Go tree"
out=$("$R/usr/local/bin/go" version) || fail "the amd64 go does not run through binfmt"
[[ $out == "go version go$(pin GO_VERSION) linux/amd64" ]] || fail "go version: $out"
pass "go.dev's go$(pin GO_VERSION) linux-amd64 matched the pinned sha256; its go runs here: $out"
deb=$(ls "$A"/debs/powershell_*_amd64.deb)
[[ $(dpkg-deb -f "$deb" Package Architecture | tr '\n' ' ') == "Package: powershell Architecture: amd64 " ]] || fail "powershell deb"
grep -q "^deb \[arch=amd64 signed-by=/usr/share/keyrings/microsoft-prod.gpg\] https://packages.microsoft.com/ubuntu/24.04/prod noble main$" \
    "$R/etc/apt/sources.list.d/microsoft-prod.list" || fail "Microsoft source line"
amd64 --check go > /dev/null || fail "system-tools.sh --check go"
pass "Microsoft's key matched the pinned fingerprint; apt verified noble's repository with it and fetched $(basename "$deb")"

# The reserve, through provision.sh: the drop-ins, applied by daemon-reload to running units.
bash "$here/provision.sh" reserve > "$work/reserve-1.log" 2>&1 || { cat "$work/reserve-1.log"; fail "provision.sh reserve"; }
bash "$here/provision.sh" reserve > "$work/reserve-2.log" 2>&1 || { cat "$work/reserve-2.log"; fail "provision.sh reserve rerun"; }
grep '^==> installed' "$work/reserve-2.log" && fail "provision.sh reserve's rerun changed something"
[[ $(cat /sys/fs/cgroup/bite.slice/cpu.weight) == 1000 && $(cat /sys/fs/cgroup/bite.slice/io.weight 2>/dev/null || echo 'default 1000') == 'default 1000' ]] ||
    fail "bite.slice weights: cpu $(cat /sys/fs/cgroup/bite.slice/cpu.weight)"
# A changed weight reaches the running slice with a daemon-reload alone (the live workbox's one-time step).
sed 's/^CPUWeight=.*/CPUWeight=500/' "$here/../../workbox/systemd/system/bite.slice" > /etc/systemd/system/bite.slice
systemctl daemon-reload
[[ $(cat /sys/fs/cgroup/bite.slice/cpu.weight) == 500 ]] || fail "daemon-reload did not apply a running slice's new CPUWeight"
install -m 0644 "$here/../../workbox/systemd/system/bite.slice" /etc/systemd/system/bite.slice
systemctl daemon-reload
[[ $(cat /sys/fs/cgroup/bite.slice/cpu.weight) == 1000 ]] || fail "bite.slice back to 1000"
pass "a running slice takes a changed CPUWeight on daemon-reload, without a restart"
four=4294967296 one=1073741824
for cg in user.slice "user.slice/user-$uid.slice" "user.slice/user-$uid.slice/user@$uid.service"; do
    [[ $(cat "/sys/fs/cgroup/$cg/memory.low") == "$four" && $(cat "/sys/fs/cgroup/$cg/memory.min") == "$one" ]] || fail "$cg memory floor"
done
runuser -u "$user" -- env XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user daemon-reload
tools_scope=opencode-service-$$.scope
runuser -u "$user" -- env XDG_RUNTIME_DIR="/run/user/$uid" systemd-run --user --scope --quiet --collect --unit="$tools_scope" sleep 60 &
scope_job=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
    scope_cg=/sys/fs/cgroup/user.slice/user-$uid.slice/user@$uid.service/app.slice/$tools_scope
    [[ -e $scope_cg/memory.low ]] && break
    sleep 1
done
for cg in "$(dirname "$scope_cg")" "$scope_cg"; do
    [[ $(cat "$cg/memory.low") == "$four" && $(cat "$cg/memory.min") == "$one" ]] || fail "${cg##*/} memory floor: $(cat "$cg/memory.low")"
done
pass "bite.slice CPUWeight 1000; the memory floor 1G/4G on user.slice, the user's slice and manager, app.slice and a transient $tools_scope"
runuser -u "$user" -- env XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user stop "$tools_scope"
wait "$scope_job" 2>/dev/null || true
tools_scope=''

# The run families (workbox/slices.conf, by provision.sh reserve): slices of the user's own manager.
uctl() { runuser -u "$user" -- env XDG_RUNTIME_DIR="/run/user/$uid" "$@"; }
manager=/sys/fs/cgroup/user.slice/user-$uid.slice/user@$uid.service
uctl systemctl --user daemon-reload
for c in cpu io memory; do
    grep -qw "$c" "$manager/cgroup.controllers" || fail "the user manager has no $c controller: $(cat "$manager/cgroup.controllers")"
done
systemctl show -p DelegateControllers "user@$uid.service" | grep -qw io || fail "user@$uid.service does not delegate io"
# A run placed by the user alone (no root): systemd-run --user --scope --slice=<family>.slice.
uctl systemd-run --user --scope --quiet --collect --unit=hbt-place.scope --slice=ergo.slice sleep 30 &
place_job=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do [[ -n $(cat "$manager/ergo.slice/hbt-place.scope/cgroup.procs" 2>/dev/null) ]] && break; sleep 1; done
[[ -n $(cat "$manager/ergo.slice/hbt-place.scope/cgroup.procs" 2>/dev/null) ]] || fail "the run is not in ergo.slice: $(find "$manager" -name 'hbt-place.scope')"
mem_total=$(awk '/^MemTotal:/ { print $2 * 1024 }' /proc/meminfo)
high=$(cat "$manager/ergo.slice/memory.high")
[[ $(cat "$manager/ergo.slice/cpu.weight") == 20 && $(cat "$manager/ergo.slice/cpu.max") == "1000000 100000" ]] ||
    fail "ergo.slice: cpu.weight $(cat "$manager/ergo.slice/cpu.weight"), cpu.max $(cat "$manager/ergo.slice/cpu.max")"
# MemoryHigh=80%, above Ergo's own bound on its gates (slices.conf), to the page.
awk -v h="$high" -v m="$mem_total" 'BEGIN { exit !(h > m * 0.79 && h < m * 0.81) }' || fail "ergo.slice memory.high $high, want 80% of $mem_total"
[[ $(cat "$manager/ergo.slice/io.weight" 2>/dev/null) == "default 20" ]] || fail "ergo.slice io.weight: $(cat "$manager/ergo.slice/io.weight" 2>&1)"
uctl systemctl --user stop hbt-place.scope
wait "$place_job" 2>/dev/null || true
pass "the user manager has cpu, io and memory; a run placed with systemd-run --user --slice=ergo.slice lands there: cpu.weight 20, cpu.max 10 CPUs, memory.high 80%, io.weight 20"
# Ergo's gate places itself in ergo-gates.slice (its scripts/gate/scope_linux.go): systemd nests it in
# ergo.slice by the dash, so the family's values hold over it. The callers' contract: a family's slice
# answers `systemctl --user cat`; a name with no unit is not refused by systemd-run, it is made at the
# defaults, which is why a caller checks with cat first.
uctl systemd-run --user --scope --quiet --collect --unit=hbt-gate.scope --slice=ergo-gates.slice sleep 30 &
gate_job=$!
uctl systemd-run --user --scope --quiet --collect --unit=hbt-none.scope --slice=hbt-nosuch.slice sleep 30 &
none_job=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
    [[ -n $(cat "$manager/ergo.slice/ergo-gates.slice/hbt-gate.scope/cgroup.procs" 2>/dev/null) &&
        -n $(cat "$manager/hbt.slice/hbt-nosuch.slice/hbt-none.scope/cgroup.procs" 2>/dev/null) ]] && break
    sleep 1
done
[[ -n $(cat "$manager/ergo.slice/ergo-gates.slice/hbt-gate.scope/cgroup.procs" 2>/dev/null) ]] ||
    fail "a run in ergo-gates.slice is not under ergo.slice: $(find "$manager" -name 'hbt-gate.scope')"
[[ -n $(cat "$manager/hbt.slice/hbt-nosuch.slice/hbt-none.scope/cgroup.procs" 2>/dev/null) &&
    $(cat "$manager/hbt.slice/hbt-nosuch.slice/cpu.weight" 2>/dev/null || echo 100) == 100 ]] || fail "a slice with no unit: $(find "$manager" -name 'hbt-none.scope')"
for f in opencode ergo bite-work personal; do
    uctl systemctl --user cat "$f.slice" >/dev/null 2>&1 || fail "systemctl --user cat $f.slice"
done
if uctl systemctl --user cat hbt-nosuch.slice >/dev/null 2>&1; then fail "systemctl --user cat found a slice with no unit"; fi
uctl systemctl --user stop hbt-gate.scope hbt-none.scope
wait "$gate_job" "$none_job" 2>/dev/null || true
pass "Ergo's ergo-gates.slice runs under ergo.slice; each family answers systemctl --user cat; a slice with no unit is made with no settings of its own (no cpu.weight, or 100) and cat exits non-zero for it"
# Two CPU-bound runs, two busy loops each on this 2-CPU VM, in personal.slice (100) and ergo.slice
# (20): over 20 s they share the CPU near 5:1. While both run, the sshd in bite.slice still answers.
for s in personal ergo; do
    uctl systemd-run --user --scope --quiet --collect --unit="hbt-cpu-$s.scope" --slice="$s.slice" \
        sh -c 'while :; do :; done & while :; do :; done' &
done
sleep 2
usage() { awk '/^usage_usec/ { print $2 }' "$manager/$1.slice/cpu.stat"; }
p0=$(usage personal) e0=$(usage ergo)
ssh_start=$(date +%s%N)
ssh -p 2299 -i "$work/id_test" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
    -o UserKnownHostsFile=/dev/null "$user@127.0.0.1" true 2>"$work/ssh-load.err" || { cat "$work/ssh-load.err"; fail "ssh while the runs spin"; }
ssh_ms=$((($(date +%s%N) - ssh_start) / 1000000))
sleep 20
p1=$(usage personal) e1=$(usage ergo)
for s in personal ergo; do uctl systemctl --user stop "hbt-cpu-$s.scope"; done
wait 2>/dev/null || true
ratio=$(awk -v p=$((p1 - p0)) -v e=$((e1 - e0)) 'BEGIN { printf "%.2f", p / (e > 0 ? e : 1) }')
awk -v r="$ratio" 'BEGIN { exit !(r > 3.5 && r < 7) }' || fail "personal:ergo CPU time $ratio:1 over 20 s, want near 5:1"
((ssh_ms < 5000)) || fail "ssh took $ssh_ms ms while the runs spun"
pass "CPU-bound runs in personal.slice (100) and ergo.slice (20) got $ratio:1 over 20 s; ssh into bite.slice's sshd took $ssh_ms ms meanwhile"

# /tmp's rules and the held-file guard, installed for real; the guard on the target's /tmp with short
# ages: an old directory goes, one a process holds open (an open file, a working directory) stays;
# without the guard tmpfiles takes the held one too.
bash "$tools" tmp > "$work/tmp-1.log" 2>&1 || { cat "$work/tmp-1.log"; fail "system-tools.sh tmp"; }
bash "$tools" tmp > "$work/tmp-2.log" 2>&1 || { cat "$work/tmp-2.log"; fail "system-tools.sh tmp rerun"; }
grep '^==>' "$work/tmp-2.log" && fail "system-tools.sh tmp's rerun changed something"
[[ $(systemctl show -p ExecStart systemd-tmpfiles-clean.service) == *workbox-tmp-clean* ]] || fail "the daily clean does not run workbox-tmp-clean"
mkdir -p "$T/tmp/old/sub" "$T/tmp/held-file" "$T/tmp/held-cwd/x" "$T/tmp/opencode/old-run"
touch "$T/tmp/old/sub/f" "$T/tmp/held-file/f" "$T/tmp/held-file/g" "$T/tmp/held-cwd/x/f" "$T/tmp/opencode/old-run/f"
printf 'D %s 1777 root root 2s\nD %s - - - 1h\n' "$T/tmp" "$T/tmp/opencode" > "$work/age-tmp.conf"
sleep 3
( exec 9<"$T/tmp/held-file/f"; sleep 30 ) &
hold1=$!
( cd "$T/tmp/held-cwd" && sleep 30 ) &
hold2=$!
sleep 1
WORKBOX_TMP_ROOTS=$T/tmp /usr/local/sbin/workbox-tmp-clean "$work/age-tmp.conf" > "$work/clean.log" 2>&1 || { cat "$work/clean.log"; fail "workbox-tmp-clean"; }
[[ ! -e $T/tmp/old && ! -e $T/tmp/held-file/g ]] || fail "the cleaner kept old entries: $(find "$T/tmp" | tr '\n' ' ')"
[[ -e $T/tmp/held-file/f && -e $T/tmp/held-cwd/x/f && -e $T/tmp/opencode/old-run/f ]] ||
    fail "the cleaner took a held entry or /tmp/opencode's (its own line, 1h): $(find "$T/tmp" | tr '\n' ' ')"
grep -q '2 held paths locked' "$work/clean.log" || { cat "$work/clean.log"; fail "the guard's count"; }
systemd-tmpfiles --clean "$work/age-tmp.conf" 2>/dev/null || true
[[ ! -e $T/tmp/held-file/f ]] || fail "plain tmpfiles kept the held file: the guard proved nothing"
kill "$hold1" "$hold2" 2>/dev/null
wait "$hold1" "$hold2" 2>/dev/null || true
rm -rf "$T/tmp/held-cwd" "$T/tmp/held-file" "$T/tmp/opencode/old-run"
pass "the daily clean runs workbox-tmp-clean: an aged directory goes, one held open (file or working directory) stays, /tmp/opencode keeps its own age; plain tmpfiles would take the held one"

# The free-space figures: btrfs filesystem usage's, readable by the user.
WORKBOX_DISK_FREE_OUT=$work/run-workbox/disk-free sh "$here/../../workbox/systemd/disk-free/workbox-disk-free" "$T/workspaces" ||
    fail "workbox-disk-free"
figures=$(runuser -u "$user" -- cat "$work/run-workbox/disk-free") || fail "the user cannot read the free-space file"
fe=$(sed -n 's/^free_estimated=//p' <<<"$figures") un=$(sed -n 's/^unallocated=//p' <<<"$figures") size=$(sed -n 's/^device_size=//p' <<<"$figures")
want=$(btrfs filesystem usage -b "$T/workspaces" | awk '/Free \(estimated\):/ { print $3 }')
[[ $fe =~ ^[0-9]+$ && $un =~ ^[0-9]+$ && $size =~ ^[0-9]+$ ]] && ((fe <= size && un <= size)) || fail "free-space figures: $figures"
awk -v a="$fe" -v b="$want" 'BEGIN { d = a - b; if (d < 0) d = -d; exit !(d <= 64 * 1048576) }' || fail "free_estimated $fe, btrfs says $want"
pass "workbox-disk-free: free_estimated $((fe >> 20)) MiB (btrfs's Free (estimated)), unallocated $((un >> 20)) MiB, readable by $user"

bash "$tools" --check shells qemu reserve slices tmp > /dev/null || fail "system-tools.sh --check"
pass "system-tools.sh --check shells qemu reserve slices tmp"

# ------------------------------------------------------------------ 4
step "sync.sh from a scratch exe box"
new_loop 2G "$work/exe.img"; src_disk=$loop
mkfs.btrfs -q -f "$src_disk"
mount "$src_disk" "$work/top"
for sv in @home @workspaces @tmp; do btrfs subvolume create "$work/top/$sv" >/dev/null; done
umount "$work/top"
mkdir -p "$S/home" "$S/workspaces" "$S/tmp"
for sv in home workspaces tmp; do mount -o "subvol=@$sv,compress=zstd:3" "$src_disk" "$S/$sv"; done
# The home: a reflinked pair, a hard-linked pair, an xattr, a symlink, a nested subvolume.
mkdir -p "$S/home/Developer/personal/app" "$S/home/Developer/personal/store"
head -c $((48 << 20)) /dev/urandom > "$S/home/Developer/personal/store/big"
cp --reflink=always "$S/home/Developer/personal/store/big" "$S/home/Developer/personal/app/big"
echo module > "$S/home/Developer/personal/store/mod.js"
ln "$S/home/Developer/personal/store/mod.js" "$S/home/Developer/personal/app/mod.js"
# Caches (storage.conf's cache lines), which the copy leaves out: bun's store and Go's build cache in
# the home; in /workspaces/.cache, Ergo's Go cache and one nobody listed (the whole .cache is one).
mkdir -p "$S/home/.bun/install/cache" "$S/home/.cache/go-build/00" "$S/workspaces/.cache/ergo-gocache" "$S/workspaces/.cache/gocache-unlisted"
head -c $((2 << 20)) /dev/urandom > "$S/home/.bun/install/cache/pkg.tgz"
echo object > "$S/home/.cache/go-build/00/a-d"
head -c $((2 << 20)) /dev/urandom > "$S/workspaces/.cache/ergo-gocache/x-d"
echo y > "$S/workspaces/.cache/gocache-unlisted/y"
setfattr -n user.hb -v kept "$S/home/Developer/personal/app/mod.js"
ln -s Developer/personal/app "$S/home/app-link"
btrfs subvolume create "$S/home/Developer/personal/sub" >/dev/null
echo nested > "$S/home/Developer/personal/sub/file"
# /workspaces: a warm source, two Rifts, a read-only snapshot, a plain cache.
btrfs subvolume create "$S/workspaces/bite" >/dev/null
head -c $((48 << 20)) /dev/urandom > "$S/workspaces/bite/node_modules.bin"
echo 'export const a = 1' > "$S/workspaces/bite/index.ts"
mkdir -p "$S/workspaces/.rifts/bite" "$S/workspaces/.cache/turbo"
echo turbo > "$S/workspaces/.cache/turbo/entry"
# Owned by the user before the snapshots, as on the exe box (a read-only one cannot change).
chown -R "$uid:$uid" "$S/home" "$S/workspaces"
btrfs subvolume snapshot "$S/workspaces/bite" "$S/workspaces/.rifts/bite/feat" >/dev/null
echo 'export const a = 2' > "$S/workspaces/.rifts/bite/feat/index.ts"
btrfs subvolume snapshot -r "$S/workspaces/bite" "$S/workspaces/.rifts/bite/base-ro" >/dev/null
# The paths outside the subvolumes.
mkdir -p "$S/var/lib/mongodb" "$S/usr/local/bin"
echo wired > "$S/var/lib/mongodb/WiredTiger"
echo go > "$S/usr/local/bin/go"
export HB_TO=local HB_TARGET_ANCHOR=$T/workspaces HB_SNAPDIR=$S/tmp/.hetzner-sync \
    HB_SYNC_SUBVOLS="@home:$S/home @workspaces:$S/workspaces" \
    HB_RSYNC_PATHS="$S/var/lib/mongodb $S/usr/local" HB_TARGET_PREFIX=$work/rest-target

HB_TO='' bash "$here/sync.sh" --dry-run pass 1 > "$work/dry-1.log"
cat "$work/dry-1.log"
total=$(awk '/^btrfs total/ { print $(NF - 1) }' "$work/dry-1.log")
awk -v t="$total" 'BEGIN { exit !(t > 0.09 && t < 0.13) }' || fail "dry run pass 1 counts $total GB, want about 0.10 (two 48 MiB files; the reflink and the Rift clone)"
feat=$(awk '$1 ~ /feat$/ { print $(NF - 1) }' "$work/dry-1.log")
grep -E 'feat +from its origin' "$work/dry-1.log" >/dev/null && awk -v t="$feat" 'BEGIN { exit !(t < 0.01) }' ||
    fail "the Rift is not sent against its warm source"
grep -q 'At \$0.05/GB' "$work/dry-1.log" || fail "dry run prints no cost line"
[[ ! -e $S/tmp/.hetzner-sync/1.dry && ! -e $S/tmp/.hetzner-sync/1 ]] || fail "dry run left snapshots"
pass "dry run: $total GB for pass 1, the Rift as a delta of its source, nothing left behind"

# What a real pass stores on the target is what it sent: a Rift sent in full
# instead of against its origin adds its 48 MiB again, a pass 2 sent in full
# adds everything again. Data use is logical (raid1 not doubled), committed first.
data_used() { btrfs filesystem sync "$T/workspaces"; btrfs filesystem df -b "$T/workspaces" | awk -F'used=' '/^Data/ { print $2 + 0 }'; }
mib() { echo $(($1 >> 20)); }
used0=$(data_used)
bash "$here/sync.sh" pass 1 > "$work/pass-1.log" 2>&1 || { cat "$work/pass-1.log"; fail "pass 1"; }
grep -E '^==> send .*feat \(from its origin\)' "$work/pass-1.log" >/dev/null || { cat "$work/pass-1.log"; fail "pass 1 did not send the Rift against its origin"; }
grown1=$(($(data_used) - used0))
# Two 48 MiB files of random data (the home's reflink and the Rifts share them) and a few small ones.
((grown1 > 90 << 20 && grown1 < 110 << 20)) || { cat "$work/pass-1.log"; fail "pass 1 stored $(mib "$grown1") MiB on the target, want about 96 (each 48 MiB file once)"; }
pass "pass 1: $(mib "$grown1") MiB stored, each 48 MiB file once"
# Changes between the passes: an edit, a deletion, a new Rift, a new file.
echo 'export const a = 3' > "$S/workspaces/.rifts/bite/feat/index.ts"
rm "$S/workspaces/bite/index.ts"
btrfs subvolume snapshot "$S/workspaces/bite" "$S/workspaces/.rifts/bite/feat2" >/dev/null
head -c $((1 << 20)) /dev/urandom > "$S/home/Developer/personal/app/new.bin"
chown -R "$uid:$uid" "$S/home/Developer/personal/app/new.bin"
HB_TO='' bash "$here/sync.sh" --dry-run pass 2 > "$work/dry-2.log"
total2=$(awk '/^btrfs total/ { print $(NF - 1) }' "$work/dry-2.log")
awk -v t="$total2" 'BEGIN { exit !(t < 0.005) }' || { cat "$work/dry-2.log"; fail "dry run pass 2 counts $total2 GB, want only the changes"; }
grep -E 'since pass 1' "$work/dry-2.log" >/dev/null || fail "pass 2 is not incremental"
pass "dry run pass 2: $total2 GB, incremental"
used1=$(data_used)
bash "$here/sync.sh" pass 2 > "$work/pass-2.log" 2>&1 || { cat "$work/pass-2.log"; fail "pass 2"; }
grep '^==> send' "$work/pass-2.log" | grep -v -E '\((since pass 1|from its origin.*)\)$' && { cat "$work/pass-2.log"; fail "pass 2 sent a subvolume in full"; }
grown2=$(($(data_used) - used1))
# The 1 MiB new file and small edits; a full resend would add about 96 MiB again.
((grown2 < 8 << 20)) || { cat "$work/pass-2.log"; fail "pass 2 stored $(mib "$grown2") MiB on the target, want only the changes (about 1)"; }
bash "$here/sync.sh" pass 2 > "$work/pass-2b.log" 2>&1 || { cat "$work/pass-2b.log"; fail "pass 2 rerun"; }
grep -q '^==> send' "$work/pass-2b.log" && fail "pass 2's rerun sent again"
pass "pass 2: $(mib "$grown2") MiB stored, every subvolume incremental, and its rerun sends nothing"
bash "$here/sync.sh" rest > "$work/rest.log" 2>&1 || { cat "$work/rest.log"; fail "rest"; }
[[ $(cat "$work/rest-target$S/var/lib/mongodb/WiredTiger") == wired && -f $work/rest-target$S/usr/local/bin/go ]] || fail "rest did not copy"
pass "rest: rsync of the paths outside the subvolumes"
bash "$here/sync.sh" activate 2 > "$work/activate.log" 2>&1 || { cat "$work/activate.log"; fail "activate"; }
# What the reboot would do: mount the subvolumes by name again.
umount "$T/home/$user" "$T/workspaces"
mount -o subvol=@home,compress=zstd:3,user_subvol_rm_allowed "${d1}p4" "$T/home/$user"
mount -o subvol=@workspaces,compress=zstd:3,user_subvol_rm_allowed "${d1}p4" "$T/workspaces"
# The caches stayed behind: absent on the target, untouched at the source.
grep -q '^==> leaving out the cache ' "$work/pass-1.log" || { cat "$work/pass-1.log"; fail "pass 1 named no cache it left out"; }
for c in .bun/install/cache .cache/go-build; do
    [[ ! -e $T/home/$user/$c ]] || fail "the cache ~/$c was copied"
done
[[ ! -e $T/workspaces/.cache ]] || fail "/workspaces/.cache was copied: $(find "$T/workspaces/.cache" | head -n 5 | tr '\n' ' ')"
[[ -s $S/home/.bun/install/cache/pkg.tgz && -s $S/workspaces/.cache/ergo-gocache/x-d && -s $S/workspaces/.cache/turbo/entry ]] ||
    fail "a source cache lost its files"
pass "the caches stayed behind (named in pass 1's log): not on the target, untouched at the source"
# Everything else is equal, owners and modes too.
for d in home:"$T/home/$user":'\./(\.cache/go-build|\.bun/install/cache)(/|$)' workspaces:"$T/workspaces":'\./\.cache(/|$)'; do
    IFS=: read -r name b leave <<<"$d"
    a=$S/$name
    diff -r --no-dereference -x go-build -x cache -x .cache "$a" "$b" >/dev/null || fail "$b differs from $a"
    (cd "$a" && find . -printf '%U %G %m %y %p\n' | sort | grep -v -E " $leave") > "$work/meta-a"
    (cd "$b" && find . -printf '%U %G %m %y %p\n' | sort | grep -v -E " $leave") > "$work/meta-b"
    diff "$work/meta-a" "$work/meta-b" >/dev/null || { diff "$work/meta-a" "$work/meta-b" | head; fail "owners or modes differ under $b"; }
done
pass "the target's home and /workspaces equal the source's but for the caches, owners and modes too"
# The boot after activate: hetzner-workbox-storage.service makes each cache an empty limited
# subvolume in the received trees. A received subvolume has its own qgroup (simple quotas count what
# the receive wrote into it); the limits are storage.conf's, not carried by the stream.
bash "$HB_LIB/storage.sh" apply > "$work/storage-after-sync.log" 2>&1 || { cat "$work/storage-after-sync.log"; fail "storage.sh apply after activate"; }
grep -q '^==> make subvolume .*/\.cache/go-build$' "$work/storage-after-sync.log" || { cat "$work/storage-after-sync.log"; fail "the home's .cache/go-build not made after activate"; }
for c in "$T/home/$user/.bun/install/cache" "$T/workspaces/.cache/ergo-gocache" "$T/workspaces/.cache/turbo"; do
    [[ $(stat -c %i "$c") == 256 && -z $(ls -A "$c") && $(cat "$(qgroup_of "$c")/max_referenced") != 0 ]] || fail "$c after activate"
done
feat_q=$(qgroup_of "$T/workspaces/.rifts/bite/feat")
[[ $(cat "$feat_q/max_referenced") == 0 ]] || fail "a received Rift came with a limit: $(cat "$feat_q/max_referenced")"
(($(cat "$feat_q/exclusive") < 1 << 20)) || fail "the received Rift feat counts $(cat "$feat_q/exclusive") bytes, want only its own edits (it was received against its source)"
pass "after activate, the caches are empty limited subvolumes again; a received Rift has its own qgroup counting $(cat "$feat_q/exclusive") bytes (its own edits), no limit"
h=$T/home/$user
[[ $(stat -c %i "$h/Developer/personal/store/mod.js") == $(stat -c %i "$h/Developer/personal/app/mod.js") ]] || fail "hard link lost"
[[ $(getfattr --only-values -n user.hb "$h/Developer/personal/app/mod.js") == kept ]] || fail "xattr lost"
pass "hard links and xattrs kept"
for sv in "$h/Developer/personal/sub" "$T/workspaces/bite" "$T/workspaces/.rifts/bite/feat" "$T/workspaces/.rifts/bite/feat2"; do
    btrfs subvolume show "$sv" >/dev/null 2>&1 || fail "$sv is not a subvolume"
done
[[ $(btrfs property get -ts "$T/workspaces/.rifts/bite/base-ro" ro) == ro=true ]] || fail "read-only snapshot came back writable"
[[ $(btrfs property get -ts "$T/workspaces/.rifts/bite/feat" ro) == ro=false ]] || fail "a Rift came back read-only"
pass "nested subvolumes are subvolumes again; read-only stays read-only, Rifts stay writable"
# Sharing with the source itself, not with any copy: the same physical extents.
# (btrfs filesystem du counts data shared with anything, and the received pass
# snapshots share with the activated copies whatever the send did.)
extents() { filefrag -v "$1" | awk '$1 ~ /^[0-9]+:$/ { print $4 }'; }
same_extents() { # a b -> both files on the same, nonempty list of physical extents
    local x y
    x=$(extents "$1") y=$(extents "$2")
    [[ -n $x && $x == "$y" ]]
}
w=$T/workspaces
for r in .rifts/bite/feat .rifts/bite/feat2 .rifts/bite/base-ro; do
    same_extents "$w/bite/node_modules.bin" "$w/$r/node_modules.bin" ||
        { filefrag -v "$w/bite/node_modules.bin" "$w/$r/node_modules.bin"; fail "$r holds its own copy of its source's data"; }
done
same_extents "$h/Developer/personal/store/big" "$h/Developer/personal/app/big" || fail "the reflinked pair came apart"
pass "Rifts share their source's extents, reflinks stay reflinks"

# ------------------------------------------------------------------ 4b
step "a lane's life on simple quotas, as the user (Ergo's work: snapshot, trash, delete; its size unprivileged)"
w=$T/workspaces
btrfs subvolume create "$w/hbt-base" >/dev/null
head -c $((20 << 20)) /dev/urandom > "$w/hbt-base/dep.bin"
chown -R "$user:$user" "$w/hbt-base"
install -d -o "$user" -g "$user" "$w/hbt-lanes" "$w/.work-trash"
as_user btrfs subvolume snapshot "$w/hbt-base" "$w/hbt-lanes/lane" >/dev/null || fail "the user cannot snapshot the base"
btrfs filesystem sync "$w"
lane_id=$(as_user btrfs inspect-internal rootid "$w/hbt-lanes/lane") || fail "the user cannot read the lane's subvolume id"
lane_q=$qgroups/0_$lane_id
# Read as the user: the kernel's qgroup files are world-readable (0444).
before=$(as_user cat "$lane_q/exclusive") || fail "the user cannot read $lane_q/exclusive"
as_user dd if=/dev/urandom of="$w/hbt-lanes/lane/work.bin" bs=1M count=100 conv=fsync status=none
btrfs filesystem sync "$w"
after=$(as_user cat "$lane_q/exclusive")
((before < 1 << 20)) || fail "a fresh lane counts $before bytes exclusive, want only its root"
((after - before >= 100 << 20 && after - before < 102 << 20)) || fail "after 100 MiB in the lane its exclusive grew by $(((after - before) >> 20)) MiB"
# What needs root is refused to the user, and nothing grants it: no sudoers line names btrfs.
if as_user btrfs qgroup show -reF --raw "$w/hbt-lanes/lane" >/dev/null 2>&1; then fail "btrfs qgroup show ran as the user"; fi
if as_user btrfs qgroup limit 1G "$w/hbt-lanes/lane" >/dev/null 2>&1; then fail "the user set a qgroup limit"; fi
grep -rqs btrfs /etc/sudoers /etc/sudoers.d/ && fail "a sudoers line names btrfs"
as_user mv "$w/hbt-lanes/lane" "$w/.work-trash/lane" || fail "the user cannot rename a lane into the trash"
as_user btrfs subvolume delete "$w/.work-trash/lane" >/dev/null || fail "the user cannot delete a lane (user_subvol_rm_allowed)"
[[ ! -e $w/.work-trash/lane ]] || fail "the deleted lane is still there"
btrfs subvolume delete "$w/hbt-base" >/dev/null
rmdir "$w/hbt-lanes" "$w/.work-trash"
pass "as $user: snapshot of a subvolume base, exclusive $before then $after bytes after 100 MiB (read from $lane_q, 0444), renamed into the trash, deleted; qgroup show and limit refused, no sudoers line"

# ------------------------------------------------------------------ 5
step "backup.sh"
install -d "$work/storagebox"
openssl rand -hex 32 > "$work/backup.key"
export HB_BACKUP_DIR=$work/storagebox HB_BACKUP_KEY=$work/backup.key HB_SNAPSHOT_DIR=$T/var/lib/btrbk/snapshots \
    HB_BACKUP_SUBVOLS="$T/home/$user $T/workspaces"
bash "$here/backup.sh" run > "$work/backup-1.log" 2>&1 || { cat "$work/backup-1.log"; fail "backup run"; }
echo 'export const a = 4' > "$T/workspaces/.rifts/bite/feat/index.ts"
sleep 1 # snapshot names carry the second
bash "$here/backup.sh" run > "$work/backup-2.log" 2>&1 || { cat "$work/backup-2.log"; fail "backup run 2"; }
month=$(date -u +%Y-%m)
dir=$work/storagebox/bite-cristian/$month
info=$(find "$dir" -maxdepth 1 -name '*.info' | wc -l)
((info >= 6)) || fail "backup wrote $info .info files, want one per subvolume and night"
feat_name=$(ls "$dir" | sed -n 's/\(.*_rifts\.bite\.feat\)\..*\.info$/\1/p' | sort -u)
[[ -n $feat_name ]] || fail "no backup of the Rift feat"
grep -lE '^RECEIVED_PARENT_UUID=[0-9a-f]{8}-' "$dir/$feat_name".*.info >/dev/null || fail "the second backup is not incremental"
[[ $(ls "$dir/$feat_name".*.info | wc -l) == 2 ]] ||
    { ls "$dir" "$T/var/lib/btrbk/snapshots"; cat "$work/backup-2.log"; fail "want two backups of the Rift feat"; }
grep -q '^encrypt=openssl_enc' "$(ls "$dir/$feat_name".*.info | head -n 1)" || fail "the backup is not encrypted"
mkdir -p "$T/restore"
bash "$here/backup.sh" restore "$feat_name" "$T/restore" > "$work/restore.log" 2>&1 || { cat "$work/restore.log"; fail "restore"; }
last=$(ls -d "$T/restore/$feat_name".* | sort | tail -n 1)
[[ $(cat "$last/index.ts") == 'export const a = 4' ]] ||
    { ls -l "$dir" "$T/restore"; cat "$work/restore.log" "$work/backup-2.log"; fail "restored Rift is not the last state"; }
pass "backup: encrypted raw files on the Storage Box dir, the second night incremental, restore gives the last state"

# ------------------------------------------------------------------ 6
step "check.sh and workbox-rift-storage"
# check.sh reads the md swap: on for it alone (see swap_off_test).
swapon /dev/md/hbt-swap
HB_CHECK_SKIP="firewall sshd backup" HB_HOME=$T/home/$user HB_WORKSPACES=$T/workspaces bash "$here/check.sh" > "$work/check.log" ||
    { cat "$work/check.log"; fail "check.sh"; }
swap_off_test
grep -q FAIL "$work/check.log" && fail "check.sh printed a FAIL"
pass "check.sh: $(grep -c '^ok' "$work/check.log") ok lines"
mkdir -p "$T/workspaces/.cache/turbo"
printf 'UUID=0000 %s btrfs subvol=@workspaces,noatime,compress=zstd:3,user_subvol_rm_allowed 0 0\n' "$T/workspaces" > "$work/fstab.native"
WORKBOX_RIFT_MOUNT=$T/workspaces WORKBOX_RIFT_FSTAB=$work/fstab.native WORKBOX_RIFT_IMAGE=$work/no-image \
    sh "$here/../../workbox/bin/workbox-rift-storage" --check >/dev/null || fail "workbox-rift-storage refuses a native /workspaces"
printf '# nothing\n' > "$work/fstab.none"
if WORKBOX_RIFT_MOUNT=$T/workspaces WORKBOX_RIFT_FSTAB=$work/fstab.none WORKBOX_RIFT_IMAGE=$work/no-image \
    sh "$here/../../workbox/bin/workbox-rift-storage" --check >/dev/null 2>&1; then fail "workbox-rift-storage accepts a /workspaces with no fstab line"; fi
pass "workbox-rift-storage --check: native line yes, no line no"

# ------------------------------------------------------------------ 7
# What simple quotas cost where full qgroups hurt: 200 snapshots of a 2,000-file base, each changed a
# little, then deleted, timed to the cleaner's end (btrfs subvolume sync), with quotas off and with
# simple quotas on a fresh btrfs each.
step "simple quotas: the cost of 200 snapshots made and deleted"
new_loop 3G "$work/snap.img"; snap_dev=$loop
mkdir -p "$work/snap"
snap_round() { # off|simple -> seconds
    local m=$work/snap t0 t1 i d
    mkfs.btrfs -q -f "$snap_dev"
    mount -o noatime "$snap_dev" "$m"
    [[ $1 == simple ]] && btrfs quota enable --simple "$m"
    btrfs subvolume create "$m/base" >/dev/null
    for d in $(seq 1 20); do
        mkdir "$m/base/d$d"
        for i in $(seq 1 100); do head -c 32768 /dev/urandom > "$m/base/d$d/f$i"; done
    done
    sync
    t0=$(date +%s.%N)
    for i in $(seq 1 200); do
        btrfs subvolume snapshot "$m/base" "$m/s$i" >/dev/null
        head -c 65536 /dev/urandom > "$m/s$i/d$((i % 20 + 1))/f1"
    done
    for i in $(seq 1 200); do btrfs subvolume delete "$m/s$i" >/dev/null; done
    btrfs subvolume sync "$m" >/dev/null
    t1=$(date +%s.%N)
    umount "$m"
    awk -v a="$t0" -v b="$t1" 'BEGIN { printf "%.1f", b - a }'
}
off_s=$(snap_round off)
simple_s=$(snap_round simple)
awk -v o="$off_s" -v s="$simple_s" 'BEGIN { exit !(s < 2 * o + 10) }' || fail "200 snapshots: ${simple_s}s with simple quotas, ${off_s}s without"
pass "200 snapshots made, changed and deleted (to the cleaner's end): ${off_s}s with quotas off, ${simple_s}s with simple quotas"

step "peaks over the run (the sampler, every 3 s)"
awk '{ for (i = 1; i <= NF; i++) { split($i, kv, "="); v[kv[1]] = kv[2] }
       n++
       if (n == 1 || v["avail_mb"] + 0 < lo) { lo = v["avail_mb"] + 0; at = $2; top = v["top"] }
       if (v["mem_some"] + 0 > mem) mem = v["mem_some"] + 0
       if (v["io_some"] + 0 > io) io = v["io_some"] + 0
       if (v["dirty_mb"] + 0 > dirty) dirty = v["dirty_mb"] + 0 }
     END { printf "samples %d; lowest MemAvailable %d MB at %s (largest: %s); memory pressure some avg10 max %.2f%%; IO %.2f%%; dirty max %d MB\n", n, lo, at, top, mem, io, dirty }' "$samples"

printf '\nALL OK\n'
