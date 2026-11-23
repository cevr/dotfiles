#!/usr/bin/env bash
# Runs the Hetzner workbox scripts end to end in a scratch world on a Linux VM:
#
#   1. installimage-check.sh: Hetzner's own validator on installimage.conf
#      (UEFI and BIOS), and on a broken copy, which it must refuse;
#   2. two loop "NVMe drives", the first laid out as installimage leaves it
#      (ESP, /boot, swap, one btrfs with @root @home @tmp @workspaces), then
#      layout.sh (raid1, mdraid1 /boot and swap, the second ESP), twice;
#   3. provision.sh's user, keys, packages, sshd, upgrades and sysctl phases, twice,
#      then ssh into the test sshd with a test key and sudo;
#   3b. workbox/system-tools.sh for real (provision.sh tools and reserve): the
#      shells and qemu-user-static installed and registered, twice; Go and
#      PowerShell refused on a VM that is not amd64, then, with dpkg saying amd64,
#      into a scratch root: go.dev's real tarball against the pin (its go runs
#      through the qemu binfmt entry) and Microsoft's real key against the
#      pinned fingerprint, apt verifying the repository with it and fetching the
#      amd64 powershell package; the reserve drop-ins and their cgroup values,
#      a transient opencode-service scope's too. The packages it adds to the VM
#      and the binfmt entry it registers go again at the end;
#   4. sync.sh from a scratch "exe box" btrfs (a home with hard links,
#      reflinks, xattrs and a nested subvolume; /workspaces with a warm source,
#      Rifts and a read-only snapshot): dry run, pass 1, changes, pass 2, rest,
#      activate; then the target's trees must equal the source's, Rifts must
#      share extents with their source, and the dry runs must count bytes;
#   5. backup.sh run twice into a local "Storage Box" directory, restore;
#   6. check.sh, and workbox-rift-storage --check on a native line.
#
# Root on a scratch Linux VM (sudo). It creates and removes: loop devices,
# md arrays named hbt-*, a user hbtest (uid 1990), the units and files
# provision.sh installs, and its own directory under /var/tmp.
# Usage: sudo test.sh <installimage checkout>
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd -P)
installimage_src=${1:?usage: test.sh <installimage checkout>}
[[ $(uname -s) == Linux && $(id -u) == 0 ]] || { echo 'test.sh: Linux and root' >&2; exit 2; }

work=$(mktemp -d /var/tmp/hetzner-workbox-test.XXXXXX)
# The test user's home is under it, and sshd reads authorized_keys as that user.
chmod 755 "$work"
T=$work/target S=$work/source
user=hbtest uid=1990
loops=()
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'ok: %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

# What step 3b added to the VM itself: the packages (only those not here before), the binfmt entry
# (only if it registered it), the reserve drop-ins, and its transient scope.
tools_pkgs_before=''
tools_binfmt_before=1
tools_foreign=''
cleanup_tools() {
    local f new
    [[ -n ${tools_scope:-} ]] && runuser -u "$user" -- env XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user stop "$tools_scope" >/dev/null 2>&1
    for f in system/user.slice.d system/user-.slice.d system/user@.service.d user/app.slice.d user/opencode-service-.scope.d; do
        rm -f "/etc/systemd/$f/30-workbox-reserve.conf"
        rmdir "/etc/systemd/$f" 2>/dev/null
    done
    if [[ -n $tools_pkgs_before ]]; then
        new=$(comm -13 "$tools_pkgs_before" <(dpkg-query -W -f='${Package}\n' | sort -u))
        # shellcheck disable=SC2086 # a word list
        [[ -n $new ]] && DEBIAN_FRONTEND=noninteractive apt-get purge -y -q $new >/dev/null 2>&1
    fi
    if ((tools_binfmt_before == 0)) && [[ -e /proc/sys/fs/binfmt_misc/qemu-$tools_foreign ]]; then
        printf -- '-1' > "/proc/sys/fs/binfmt_misc/qemu-$tools_foreign"
    fi
    systemctl daemon-reload
}

cleanup() {
    set +e
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
    for m in $(findmnt -rn -o TARGET | grep -E "^($work|/var/lib/hetzner-sync/top)" | sort -r); do umount "$m" || umount -l "$m"; done
    for md in /dev/md/hbt-*; do [[ -e $md ]] && mdadm --stop "$md" >/dev/null 2>&1; done
    udevadm settle
    # A stopped array's members can stay busy for a moment; udev may also
    # assemble them again, so stop whatever holds a loop partition.
    for l in "${loops[@]}"; do
        for h in /sys/block/"${l##*/}"/"${l##*/}"p*/holders/md*; do
            [[ -e $h ]] && mdadm --stop "/dev/${h##*/}" >/dev/null 2>&1
        done
        for _ in 1 2 3 4 5; do losetup -d "$l" 2>/dev/null && break; sleep 1; done
    done
    btrfs device scan --forget >/dev/null 2>&1
    if id "$user" >/dev/null 2>&1; then
        loginctl disable-linger "$user"
        systemctl stop "user@$uid.service" 2>/dev/null
        userdel "$user"
    fi
    rm -rf "$work"
}
trap cleanup EXIT

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

# ------------------------------------------------------------------ 3
step "provision.sh"
ssh-keygen -q -t ed25519 -N '' -C hb-test -f "$work/id_test"
export HB_APT_REPOS=0 HB_PACKAGES="btrbk sshfs mdadm rsync zstd attr" HB_SSH_LISTEN=127.0.0.1 HB_SSH_PORT=2299
HB_EXTRA_KEYS=$(cat "$work/id_test.pub") bash "$here/provision.sh" user keys packages sshd upgrades sysctl > "$work/prov-1.log" ||
    { cat "$work/prov-1.log"; fail "provision.sh"; }
HB_EXTRA_KEYS=$(cat "$work/id_test.pub") bash "$here/provision.sh" user keys packages sshd upgrades sysctl > "$work/prov-2.log" ||
    { cat "$work/prov-2.log"; fail "provision.sh rerun"; }
grep -E '^==> (installed|installing|user )' "$work/prov-2.log" && fail "provision.sh's rerun changed something"
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

# ------------------------------------------------------------------ 3b
step "system-tools.sh (workbox/pins.conf), for real"
tools=$here/../../workbox/system-tools.sh
pin() { sed -n "s/^$1=//p" "$here/../../workbox/pins.conf"; }
arch=$(dpkg --print-architecture)
case $arch in amd64) tools_foreign=aarch64 ;; arm64) tools_foreign=x86_64 ;; *) fail "a $arch VM" ;; esac
dpkg-query -W -f='${Package}\n' | sort -u > "$work/pkgs-before"
tools_pkgs_before=$work/pkgs-before
[[ -e /proc/sys/fs/binfmt_misc/qemu-$tools_foreign ]] || tools_binfmt_before=0
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
    'case $1 in' \
    '  update) /usr/bin/apt-get $o update -q ;;' \
    '  install) cd "$WB_APT/debs" && /usr/bin/apt-get $o download powershell ;;' \
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
bash "$tools" --check shells qemu reserve > /dev/null || fail "system-tools.sh --check"
pass "system-tools.sh --check shells qemu reserve"

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
mkdir -p "$S/home/Developer/personal/app" "$S/home/.bun/install/cache"
head -c $((48 << 20)) /dev/urandom > "$S/home/.bun/install/cache/big"
cp --reflink=always "$S/home/.bun/install/cache/big" "$S/home/Developer/personal/app/big"
echo module > "$S/home/.bun/install/cache/mod.js"
ln "$S/home/.bun/install/cache/mod.js" "$S/home/Developer/personal/app/mod.js"
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
for d in home:"$T/home/$user" workspaces:"$T/workspaces"; do
    a=$S/${d%%:*} b=${d#*:}
    diff -r --no-dereference "$a" "$b" >/dev/null || fail "$b differs from $a"
    (cd "$a" && find . -printf '%U %G %m %y %p\n' | sort) > "$work/meta-a"
    (cd "$b" && find . -printf '%U %G %m %y %p\n' | sort) > "$work/meta-b"
    diff "$work/meta-a" "$work/meta-b" >/dev/null || fail "owners or modes differ under $b"
done
pass "the target's home and /workspaces equal the source's, owners and modes too"
h=$T/home/$user
[[ $(stat -c %i "$h/.bun/install/cache/mod.js") == $(stat -c %i "$h/Developer/personal/app/mod.js") ]] || fail "hard link lost"
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
same_extents "$h/.bun/install/cache/big" "$h/Developer/personal/app/big" || fail "the reflinked pair came apart"
pass "Rifts share their source's extents, reflinks stay reflinks"

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
HB_CHECK_SKIP="firewall sshd backup" HB_HOME=$T/home/$user HB_WORKSPACES=$T/workspaces bash "$here/check.sh" > "$work/check.log" ||
    { cat "$work/check.log"; fail "check.sh"; }
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

printf '\nALL OK\n'
