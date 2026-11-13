#!/usr/bin/env bash
# Checks the btrfs layout: home and /tmp on their subvolumes, reflinks working
# under ~/Developer, the fstab order, and enough ext4 to back the image.
#
#   check.sh           after the migration: exits 1 when a check fails
#   check.sh --before  before it: reports the same things, always exits 0
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd -P)
# shellcheck source=linux/workbox-btrfs/common.sh
. "$here/common.sh"

before=false
[[ ${1:-} == --before ]] && before=true
failed=0
ok() { printf '  ok    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; failed=1; }
note() { printf '  warn  %s\n' "$*"; }

say 'Space'
df -h --output=source,fstype,size,used,avail,target "$wb_root" "$wb_workspaces" "$wb_home" "$wb_tmp" 2>/dev/null | awk '!seen[$0]++'
btrfs filesystem df "$wb_workspaces" 2>/dev/null | sed 's/^/  /'
size=$(image_size) alloc=$(image_alloc) free=$(ext4_free)
headroom=$((WB_HEADROOM_GIB * 1073741824))
unalloc=$((size - alloc))
printf '  image %s, holding %s on ext4; ext4 free %s\n' "$(gib "$size")" "$(gib "$alloc")" "$(gib "$free")"
if ((unalloc > free)); then
    note "the image may still grow by $(gib "$unalloc") but ext4 has only $(gib "$free") free: btrfs could fill the root. Free ext4 or grow the disk, then run grow.sh."
elif ((free - unalloc < headroom)); then
    note "ext4 keeps $(gib $((free - unalloc))) beyond the image, under the $(gib "$headroom") headroom"
else
    ok "ext4 backs the whole image and keeps $(gib $((free - unalloc))) for the OS core"
fi

say 'Mounts'
for sv in $wb_subvols; do
    name=${sv%%:*} mp=${sv#*:}
    if is_btrfs_mount "$mp" && [[ $(mount_subvol "$mp") == "/$name" ]]; then ok "$mp is $name"; else bad "$mp is not mounted from $name"; fi
done
[[ $(stat -c %a "$wb_tmp") == 1777 ]] && ok "$wb_tmp is 1777" || bad "$wb_tmp is mode $(stat -c %a "$wb_tmp"), not 1777"

say 'fstab'
image_line=$(grep -n "^$wb_image $wb_workspaces btrfs " "$wb_fstab" | cut -d: -f1 | head -n 1)
[[ -n $image_line ]] && ok "image line at $image_line" || bad "no image line for $wb_workspaces in $wb_fstab"
for sv in $wb_subvols; do
    name=${sv%%:*} mp=${sv#*:}
    n=$(grep -n "^UUID=[^ ]* $mp btrfs subvol=$name," "$wb_fstab" | cut -d: -f1 | head -n 1)
    if [[ -z $n ]]; then bad "no $name line"
    elif [[ -n $image_line ]] && ((n < image_line)); then bad "$name line comes before the image line"
    else ok "$name line at $n, after the image"
    fi
done
# What systemd makes of the fstab: each subvolume waits for the loop mount and
# comes before local-fs.target, so before every service, /tmp users included.
gen=/usr/lib/systemd/system-generators/systemd-fstab-generator
if [[ -x $gen ]]; then
    out=$(mktemp -d)
    SYSTEMD_FSTAB=$wb_fstab SYSTEMD_PROC_CMDLINE='' "$gen" "$out" "$out" "$out" 2>/dev/null
    for sv in $wb_subvols; do
        mp=${sv#*:}
        unit=$out/$(systemd-escape -p --suffix=mount "$mp")
        if [[ ! -f $unit ]]; then bad "systemd makes no unit for $mp"; continue; fi
        grep -q "^RequiresMountsFor=$wb_workspaces\$" "$unit" && grep -q '^Before=local-fs.target' "$unit" &&
            ok "${unit##*/} waits for $wb_workspaces and comes before local-fs.target" ||
            bad "${unit##*/} is not ordered after $wb_workspaces and before local-fs.target"
    done
    rm -r "$out"
else
    note "no $gen to check the boot order"
fi

say 'Copy-on-write'
dir=$wb_home/Developer
[[ -d $dir ]] || dir=$wb_home
probe=$(mktemp -p "$dir" .btrfs-check.XXXXXX)
head -c 1048576 /dev/urandom > "$probe"
if cp --reflink=always "$probe" "$probe.clone" 2>/dev/null; then ok "cp --reflink=always works under $dir"
else $before && note "cp --reflink=always fails under $dir (expected before)" || bad "cp --reflink=always fails under $dir"
fi
# Rift and the bun cache share blocks across subvolumes of one file system.
if cp --reflink=always "$probe" "$wb_workspaces/.btrfs-check-$$" 2>/dev/null; then
    ok "reflinks cross from $dir to $wb_workspaces"
    rm -f "$wb_workspaces/.btrfs-check-$$"
else
    $before && note "no reflinks from $dir to $wb_workspaces" || bad "no reflinks from $dir to $wb_workspaces"
fi
rm -f "$probe" "$probe.clone"

say 'Paths'
if [[ -L $wb_home/.claude/skills ]]; then
    [[ -d $wb_home/.claude/skills/ ]] && ok "$wb_home/.claude/skills resolves" || bad "$wb_home/.claude/skills -> $(readlink "$wb_home/.claude/skills") is dangling"
fi
broken=0
while IFS= read -r -d '' file; do
    IFS= read -r line < "$file" || true
    gitdir=${line#gitdir: }
    [[ $gitdir == /* ]] || gitdir=$(dirname "$file")/$gitdir
    [[ -d $gitdir ]] && continue
    # migrate.sh home records the links that were broken before it copied.
    if grep -Fxq -e "${file%/.git}" "$wb_state/broken-links" 2>/dev/null; then
        note "${file%/.git} points at a missing $gitdir, broken before the migration"
    else
        bad "${file%/.git} points at a missing $gitdir"
        broken=1
    fi
done < <(find "$wb_home/Developer" \( -name node_modules -o \( -name .git -type d \) \) -prune -o -name .git -type f -print0 2>/dev/null)
((broken)) || ok 'every worktree under ~/Developer finds its repository'
if [[ -f $wb_converted ]]; then
    while IFS=$'\t' read -r name _ _ rift head; do
        git -C "$rift" merge-base --is-ancestor "$head" HEAD 2>/dev/null && ok "$name is the Rift $rift" || bad "$name: $rift lacks $head"
    done < "$wb_converted"
fi
for unit in "$wb_home"/.config/systemd/user/*.service; do
    [[ -f $unit ]] || continue
    grep -oE '(%h|'"$wb_home"')/[^ ]+' "$unit" | sed "s#^%h#$wb_home#" | while IFS= read -r p; do
        [[ -e $p ]] || note "${unit##*/} names $p, which does not exist"
    done
done

if $before || ((failed == 0)); then say 'check.sh: done'; exit 0; fi
say 'check.sh: FAILED'
exit 1
