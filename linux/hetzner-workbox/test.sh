#!/usr/bin/env bash
# Runs the Hetzner workbox scripts end to end in a scratch world on a Linux VM:
#
#   1. installimage-check.sh: Hetzner's own validator on installimage.conf
#      (UEFI and BIOS), and on a broken copy, which it must refuse;
#   2. two loop "NVMe drives", the first laid out as installimage leaves it
#      (ESP, /boot, swap, one btrfs with @root @home @tmp @workspaces), then
#      layout.sh (raid1, mdraid1 /boot and swap, the second ESP), twice;
#   3. provision.sh's user, keys, packages, sshd and upgrades phases, twice,
#      then ssh into the test sshd with a test key and sudo;
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
T=$work/target S=$work/source
user=hbtest uid=1990
loops=()
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'ok: %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

cleanup() {
    set +e
    systemctl disable --now bite-workbox-sshd.service >/dev/null 2>&1
    rm -f /etc/systemd/system/bite-workbox-sshd.service /etc/systemd/system/bite.slice \
        /etc/ssh/bite-workbox-sshd_config /etc/ssh/bite-workbox-ssh-host-ed25519-key \
        /etc/ssh/bite-workbox-ssh-host-ed25519-key.pub "/etc/sudoers.d/90-$user"
    systemctl daemon-reload
    for s in $(awk 'NR > 1 { print $1 }' /proc/swaps); do
        case $(readlink -f "$s") in /dev/md* | /dev/loop*) swapoff "$s" ;; esac
    done
    for m in $(findmnt -rn -o TARGET | grep -E "^($work|/var/lib/hetzner-sync/top)" | sort -r); do umount "$m" || umount -l "$m"; done
    for md in /dev/md/hbt-*; do [[ -e $md ]] && mdadm --stop "$md" >/dev/null 2>&1; done
    for l in "${loops[@]}"; do losetup -d "$l"; done
    if id "$user" >/dev/null 2>&1; then
        loginctl disable-linger "$user"
        systemctl stop "user@$uid.service" 2>/dev/null
        userdel "$user"
    fi
    rm -rf "$work"
}
trap cleanup EXIT

new_loop() { # size file -> loop device with partitions
    truncate -s "$1" "$2"
    local l
    l=$(losetup --find --show --partscan "$2")
    loops+=("$l")
    echo "$l"
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
d1=$(new_loop 3G "$work/nvme0")
d2=$(new_loop 3G "$work/nvme1")
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
[[ $(awk '$3 == "btrfs"' "$T/etc/fstab" | grep -c 'subvol=@[a-z]*,noatime,compress=zstd:3') == 4 ]] || fail "fstab btrfs options"
awk '$3 == "btrfs" && $1 !~ /^UUID=/ { exit 1 }' "$T/etc/fstab" || fail "a btrfs fstab line names a device, not the UUID"
pass "fstab: /boot and swap by md UUID, btrfs by UUID with the options"
mkdir -p "$work/esp2"
mount "${d2}p1" "$work/esp2"
[[ -f $work/esp2/EFI/ubuntu/grubx64.efi ]] || fail "the second ESP lacks the copy"
umount "$work/esp2"
pass "second ESP holds the copy"
[[ $(grep -c '^ARRAY' "$T/etc/mdadm/mdadm.conf") == 2 ]] || fail "mdadm.conf lacks the arrays"
[[ $(stat -c %a "$T/tmp") == 1777 ]] || fail "/tmp mode"
pass "mdadm.conf, /tmp 1777"

# ------------------------------------------------------------------ 3
step "provision.sh"
ssh-keygen -q -t ed25519 -N '' -C hb-test -f "$work/id_test"
export HB_APT_REPOS=0 HB_PACKAGES="btrbk sshfs mdadm rsync zstd attr" HB_SSH_LISTEN=127.0.0.1 HB_SSH_PORT=2299
HB_EXTRA_KEYS=$(cat "$work/id_test.pub") bash "$here/provision.sh" user keys packages sshd upgrades > "$work/prov-1.log" ||
    { cat "$work/prov-1.log"; fail "provision.sh"; }
HB_EXTRA_KEYS=$(cat "$work/id_test.pub") bash "$here/provision.sh" user keys packages sshd upgrades > "$work/prov-2.log" ||
    { cat "$work/prov-2.log"; fail "provision.sh rerun"; }
grep -E '^==> (installed|installing|user )' "$work/prov-2.log" && fail "provision.sh's rerun changed something"
grep -q 'authorized_keys: 0 added, 3 in all' "$work/prov-2.log" || { cat "$work/prov-2.log"; fail "authorized_keys"; }
pass "provision.sh rerun changes nothing; authorized_keys holds the Mac, herdr-mobile and the extra key"
[[ $(id -u "$user") == "$uid" && $(stat -c %U "$T/home/$user") == "$user" && $(stat -c %U "$T/workspaces") == "$user" ]] || fail "user, home, /workspaces"
loginctl show-user "$user" -p Linger | grep -q yes || fail "linger"
out=$(ssh -p 2299 -i "$work/id_test" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null "$user@127.0.0.1" 'id -u; sudo -n true && echo sudo-ok' 2>/dev/null) || fail "ssh into the test sshd"
[[ $out == "$uid"$'\n'sudo-ok ]] || fail "ssh session: $out"
pass "sshd on 127.0.0.1:2299 lets $user in by key; sudo without a password"
ss -ltn 'sport = :2299' | grep -q '127.0.0.1:2299' && ! ss -ltn 'sport = :2299' | grep -q '0.0.0.0:2299' || fail "sshd listens beyond its address"
nft -c -f "$here/firewall.nft" || fail "firewall.nft does not parse"
pass "firewall.nft parses"
grep -qx 'APT::Periodic::Unattended-Upgrade "1";' /etc/apt/apt.conf.d/20auto-upgrades || fail "unattended upgrades"
pass "unattended upgrades on"
bash "$here/provision.sh" bootstrap | grep -q 'the home has no dotfiles yet' || fail "bootstrap phase before the sync"
pass "bootstrap phase waits for the synced home"

# ------------------------------------------------------------------ 4
step "sync.sh from a scratch exe box"
src_disk=$(new_loop 2G "$work/exe.img")
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
btrfs subvolume snapshot "$S/workspaces/bite" "$S/workspaces/.rifts/bite/feat" >/dev/null
echo 'export const a = 2' > "$S/workspaces/.rifts/bite/feat/index.ts"
btrfs subvolume snapshot -r "$S/workspaces/bite" "$S/workspaces/.rifts/bite/base-ro" >/dev/null
echo turbo > "$S/workspaces/.cache/turbo/entry"
chown -R "$uid:$uid" "$S/home" "$S/workspaces"
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

bash "$here/sync.sh" pass 1 > "$work/pass-1.log" 2>&1 || { cat "$work/pass-1.log"; fail "pass 1"; }
pass "pass 1"
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
bash "$here/sync.sh" pass 2 > "$work/pass-2.log" 2>&1 || { cat "$work/pass-2.log"; fail "pass 2"; }
bash "$here/sync.sh" pass 2 > "$work/pass-2b.log" 2>&1 || { cat "$work/pass-2b.log"; fail "pass 2 rerun"; }
grep -q '^==> send' "$work/pass-2b.log" && fail "pass 2's rerun sent again"
pass "pass 2, and its rerun sends nothing"
bash "$here/sync.sh" rest > "$work/rest.log" 2>&1 || { cat "$work/rest.log"; fail "rest"; }
[[ $(cat "$work/rest-target$S/var/lib/mongodb/WiredTiger") == wired && -f $work/rest-target$S/usr/local/bin/go ]] || fail "rest did not copy"
pass "rest: rsync of the paths outside the subvolumes"
bash "$here/sync.sh" activate 2 > "$work/activate.log" 2>&1 || { cat "$work/activate.log"; fail "activate"; }
# What the reboot would do: mount the subvolumes by name again.
umount "$T/home/$user" "$T/workspaces"
mount -o subvol=@home,compress=zstd:3 "${d1}p4" "$T/home/$user"
mount -o subvol=@workspaces,compress=zstd:3 "${d1}p4" "$T/workspaces"
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
shared=$(btrfs filesystem du -s --raw "$T/workspaces/bite" "$T/workspaces/.rifts/bite/feat" | awk 'NR > 1 { s += $3 } END { print s + 0 }')
((shared > 40 << 20)) || fail "the Rift shares $shared bytes with its source, want the 48 MiB file"
shared_home=$(btrfs filesystem du -s --raw "$h/.bun/install/cache/big" "$h/Developer/personal/app/big" | awk 'NR > 1 { s += $3 } END { print s + 0 }')
((shared_home > 40 << 20)) || fail "the reflinked pair shares $shared_home bytes"
pass "Rifts share extents with their source, reflinks stay reflinks"

# ------------------------------------------------------------------ 5
step "backup.sh"
install -d "$work/storagebox"
openssl rand -hex 32 > "$work/backup.key"
export HB_BACKUP_DIR=$work/storagebox HB_BACKUP_KEY=$work/backup.key HB_SNAPSHOT_DIR=$T/var/lib/btrbk/snapshots \
    HB_BACKUP_SUBVOLS="$T/home/$user $T/workspaces"
bash "$here/backup.sh" run > "$work/backup-1.log" 2>&1 || { cat "$work/backup-1.log"; fail "backup run"; }
echo 'export const a = 4' > "$T/workspaces/.rifts/bite/feat/index.ts"
bash "$here/backup.sh" run > "$work/backup-2.log" 2>&1 || { cat "$work/backup-2.log"; fail "backup run 2"; }
month=$(date -u +%Y-%m)
dir=$work/storagebox/bite-cristian/$month
info=$(find "$dir" -maxdepth 1 -name '*.info' | wc -l)
((info >= 6)) || fail "backup wrote $info .info files, want one per subvolume and night"
feat_name=$(ls "$dir" | sed -n 's/\(.*_rifts\.bite\.feat\)\..*\.info$/\1/p' | sort -u)
[[ -n $feat_name ]] || fail "no backup of the Rift feat"
grep -l RECEIVED_PARENT_UUID "$dir/$feat_name".*.info >/dev/null || fail "the second backup is not incremental"
grep -q '^encrypt=openssl_enc' "$(ls "$dir/$feat_name".*.info | head -n 1)" || fail "the backup is not encrypted"
mkdir -p "$T/restore"
bash "$here/backup.sh" restore "$feat_name" "$T/restore" > "$work/restore.log" 2>&1 || { cat "$work/restore.log"; fail "restore"; }
last=$(ls -d "$T/restore/$feat_name".* | sort | tail -n 1)
[[ $(cat "$last/index.ts") == 'export const a = 4' ]] || fail "restored Rift is not the last state"
pass "backup: encrypted raw files on the Storage Box dir, the second night incremental, restore gives the last state"

# ------------------------------------------------------------------ 6
step "check.sh and workbox-rift-storage"
HB_CHECK_SKIP="firewall sshd backup" HB_HOME=$T/home/$user HB_WORKSPACES=$T/workspaces bash "$here/check.sh" > "$work/check.log" ||
    { cat "$work/check.log"; fail "check.sh"; }
grep -q FAIL "$work/check.log" && fail "check.sh printed a FAIL"
pass "check.sh: $(grep -c '^ok' "$work/check.log") ok lines"
mkdir -p "$T/workspaces/.cache/turbo"
printf 'UUID=0000 %s btrfs subvol=@workspaces,noatime,compress=zstd:3 0 0\n' "$T/workspaces" > "$work/fstab.native"
WORKBOX_RIFT_MOUNT=$T/workspaces WORKBOX_RIFT_FSTAB=$work/fstab.native WORKBOX_RIFT_IMAGE=$work/no-image \
    sh "$here/../../workbox/bin/workbox-rift-storage" --check >/dev/null || fail "workbox-rift-storage refuses a native /workspaces"
printf '# nothing\n' > "$work/fstab.none"
if WORKBOX_RIFT_MOUNT=$T/workspaces WORKBOX_RIFT_FSTAB=$work/fstab.none WORKBOX_RIFT_IMAGE=$work/no-image \
    sh "$here/../../workbox/bin/workbox-rift-storage" --check >/dev/null 2>&1; then fail "workbox-rift-storage accepts a /workspaces with no fstab line"; fi
pass "workbox-rift-storage --check: native line yes, no line no"

printf '\nALL OK\n'
