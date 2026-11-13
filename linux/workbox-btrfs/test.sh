#!/usr/bin/env bash
# Runs grow.sh, migrate.sh (plan, convert, home, finish) and check.sh inside a
# scratch root: a loop ext4 holding a loop btrfs image, like the workbox's
# /dev/vda and /var/lib/bite-workspaces.btrfs. It touches nothing outside a
# mktemp directory and the loop devices it attaches.
#
# Needs Linux, root (run it with sudo; the home's owner is $SUDO_USER),
# btrfs-progs, e2fsprogs, rsync, lsof and git. workrift is a stub here: a
# btrfs snapshot of the warm source plus a branch switch, as workrift does.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd -P)
[[ $(uname -s) == Linux ]] || { echo 'test.sh: needs Linux' >&2; exit 2; }
[[ $(id -u) == 0 && -n ${SUDO_USER:-} && $SUDO_USER != root ]] || { echo 'test.sh: run with sudo from a normal user' >&2; exit 2; }

user=$SUDO_USER
group=$(id -gn "$user")
work=$(mktemp -d /var/tmp/workbox-btrfs-test.XXXXXX)
root=$work/root
disk_file=$work/disk.ext4
holder_pid=
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'ok: %s\n' "$*"; }

cleanup() {
    [[ -z $holder_pid ]] || kill "$holder_pid" 2>/dev/null || true
    local m
    # Deepest mounts first.
    for m in $(findmnt -rn -o TARGET | grep -F "$root" | sort -r); do umount "$m" 2>/dev/null || umount -l "$m" || true; done
    [[ -z ${disk:-} ]] || losetup -d "$disk" 2>/dev/null || true
    rm -rf "$work"
}
trap cleanup EXIT

export WB_ROOT=$root WB_USER=$user WB_HEADROOM_GIB=1
export WB_WORKRIFT=$work/bin/workrift WB_WORKTREES_CONF=$work/worktrees.conf
home=$root/home/$user
dev=$home/Developer
image=$root/var/lib/bite-workspaces.btrfs
ws=$root/workspaces
git_() { git -c user.name=t -c user.email=t@t -c init.defaultBranch=main -c advice.detachedHead=false "$@" >/dev/null 2>&1; }
as_owner() { runuser -u "$user" -- env WB_ROOT="$WB_ROOT" WB_USER="$WB_USER" WB_HEADROOM_GIB=1 \
    WB_WORKRIFT="$WB_WORKRIFT" WB_WORKTREES_CONF="$WB_WORKTREES_CONF" HOME="$home" PATH="$PATH" "$@"; }

# --- The scratch root: a 3 GiB "disk" with ext4, and a 1 GiB btrfs image on it.
truncate -s 3G "$disk_file"
disk=$(losetup --find --show "$disk_file")
mkfs.ext4 -q -F "$disk"
mkdir -p "$root"
mount "$disk" "$root"
mkdir -p "$root/etc" "$root/var/lib" "$home" "$ws" "$root/tmp"
chmod 1777 "$root/tmp"
truncate -s 1G "$image"
mkfs.btrfs -q -f "$image"
echo "$image $ws btrfs loop,noatime,compress=zstd:3,space_cache=v2,discard=async 0 0" > "$root/etc/fstab"
mount -T "$root/etc/fstab" "$ws"
export WB_DISK=$disk

# --- A home: a main checkout with worktrees, a bun-style hard link, links.
origin=$work/origin.git
git_ init --bare "$origin"
app=$dev/personal/app
mkdir -p "$app/src" "$home/.bun/install/cache/pkg" "$home/.cache" "$home/.config/systemd/user" "$dev/personal/dotfiles/skills" "$home/.claude"
echo 'export const a = 1' > "$app/src/index.ts"
echo 'run' > "$app/run"
git_ -C "$app" init
git_ -C "$app" remote add origin "$origin"
git_ -C "$app" add src run
git_ -C "$app" commit -m init
git_ -C "$app" push origin main
git_ -C "$app" fetch origin
echo 'module' > "$home/.bun/install/cache/pkg/index.js"
mkdir -p "$app/node_modules/pkg"
ln "$home/.bun/install/cache/pkg/index.js" "$app/node_modules/pkg/index.js"
ln -s "$dev/personal/dotfiles/skills" "$home/.claude/skills"
echo 'cached' > "$home/.cache/blob"
# Written out, not sparse: deleting the old home must free real ext4 space.
head -c $((1536 << 20)) /dev/zero > "$home/.cache/big"
printf '[Service]\nExecStart=%%h/Developer/personal/app/run\n' > "$home/.config/systemd/user/app.service"

wt=$dev/personal/.worktrees
# lane-a: released, with an unpushed commit and staged, unstaged and untracked work.
git_ -C "$app" worktree add "$wt/lane-a" -b lane-a
echo 'export const b = 1' > "$wt/lane-a/src/b.ts"
git_ -C "$wt/lane-a" add src/b.ts
git_ -C "$wt/lane-a" commit -m 'lane a'
echo 'staged' > "$wt/lane-a/src/staged.ts"
git_ -C "$wt/lane-a" add src/staged.ts
echo 'export const a = 2' > "$wt/lane-a/src/index.ts"
echo 'untracked' > "$wt/lane-a/notes.md"
# lane-held: held by a rule, so copied as it is.
git_ -C "$app" worktree add "$wt/lane-held" -b lane-held
# lane-unpushed: an unpushed commit and no rule, so kept.
git_ -C "$app" worktree add "$wt/lane-unpushed" -b lane-unpushed
git_ -C "$wt/lane-unpushed" commit --allow-empty -m 'not pushed'
# lane-clean: nothing unpushed, so it converts without a rule.
git_ -C "$app" worktree add "$wt/lane-clean" -b lane-clean origin/main
# lane-detached: released, detached HEAD with an unpushed commit.
git_ -C "$app" worktree add --detach "$wt/lane-detached" main
git_ -C "$wt/lane-detached" commit --allow-empty -m 'detached work'
# A stale entry whose directory is gone, like /tmp/opencode/*-base.
git_ -C "$app" worktree add "$work/stale-base" -b stale-base
rm -r "$work/stale-base"
# A worktree link whose gitdir is gone, nested in a checkout, like the live run's
# ergo/tmp/orchestrate/wf10/spike-syntax/proto/conformance/upstream/effect.
broken=$app/vendor/upstream
mkdir -p "$broken"
echo "gitdir: $app/.git/worktrees/upstream-gone" > "$broken/.git"
echo 'kept' > "$broken/file"
cat > "$WB_WORKTREES_CONF" <<'EOF'
hold lane-held owner decides
release lane-a
release lane-detached
EOF
echo 'scratch' > "$root/tmp/agent-scratch"
mkdir -p "$root/tmp/systemd-private-x"
chown -R "$user:$group" "$home"

# --- The warm source and a workrift stub.
src=$ws/app
mkdir -p "$ws/.rifts/app"
btrfs subvolume create "$src" >/dev/null
git_ clone "$origin" "$src"
chown -R "$user:$group" "$src" "$ws/.rifts"
mkdir -p "$work/bin"
cat > "$WB_WORKRIFT" <<EOF
#!/bin/sh
set -eu
case \$1 in
  sources) echo '$src' ;;
  create)
    name=\$(printf '%s' "\$2" | tr '/' '-')
    btrfs subvolume snapshot "\$WORKRIFT_SOURCE" '$ws/.rifts/app/'"\$name" >/dev/null
    git -C '$ws/.rifts/app/'"\$name" switch "\$2" >/dev/null 2>&1
    echo '$ws/.rifts/app/'"\$name" ;;
esac
EOF
# Fakes of systemctl and loginctl for `home --stop`: they record each call in
# $fake/log. A masked unit refuses to start, as systemd's does. terminate-user
# plays the Mac reconnecting over ssh at once: pam_nologin refuses the login
# while /run/nologin exists, else logind starts user@<uid> again.
fake=$work/fake
mkdir -p "$fake"
cat > "$work/bin/systemctl" <<EOF
#!/bin/bash
args=(); for a in "\$@"; do [[ \$a == --* ]] || args+=("\$a"); done
echo "systemctl \$*" >> '$fake/log'
case \${args[0]} in
  mask) touch '$fake/masked-'"\${args[1]}" ;;
  unmask) rm -f '$fake/masked-'"\${args[1]}" ;;
  start)
    if [[ -e '$fake/masked-'"\${args[1]}" ]]; then echo "refused \${args[1]} (masked)" >> '$fake/log'; exit 1; fi
    echo "started \${args[1]}" >> '$fake/log' ;;
esac
exit 0
EOF
cat > "$work/bin/loginctl" <<EOF
#!/bin/bash
echo "loginctl \$*" >> '$fake/log'
[[ \$1 == terminate-user ]] || exit 0
if [[ -e '$root/run/nologin' ]]; then echo 'login refused (nologin)' >> '$fake/log'
else '$work/bin/systemctl' start "user@\$(id -u "\$2").service" || echo 'login refused (user@ masked)' >> '$fake/log'
fi
EOF
chmod 755 "$work/bin/systemctl" "$work/bin/loginctl"
stop_env=(WB_SYSTEMCTL="$work/bin/systemctl" WB_LOGINCTL="$work/bin/loginctl" INVOCATION_ID=test-sh)
# No start of user@ before the unmask: the login in the window was kept out.
no_login_in_window() { awk '/systemctl unmask/ { exit } /^started user@/ { bad = 1 } END { exit bad }' "$fake/log"; }
block_lifted() { [[ ! -e $root/run/nologin ]] && ! compgen -G "$fake/masked-*" > /dev/null; }
chmod 755 "$WB_WORKRIFT" "$work" "$work/bin"
chmod 644 "$WB_WORKTREES_CONF"

before_inode=$(stat -c %i "$app/node_modules/pkg/index.js")
bash "$here/check.sh" --before > "$work/before.log" || fail 'check.sh --before failed'
grep -q 'fails under' "$work/before.log" || fail 'check.sh --before did not report missing reflinks on ext4'
pass 'check.sh --before reports ext4 has no reflinks'

# --- plan and convert, as the owner.
as_owner bash "$here/migrate.sh" plan > "$work/plan.log" 2> "$work/plan.err" || { cat "$work/plan.err"; fail 'plan failed'; }
grep -q "skipped $broken: " "$work/plan.err" || { cat "$work/plan.err"; fail 'plan did not warn of the broken worktree link'; }
grep -q "$broken" "$work/plan.log" && fail 'plan classified the broken worktree link'
grep -q "keep .*lane-held.*held: owner decides" "$work/plan.log" || { cat "$work/plan.log"; fail 'plan did not hold lane-held'; }
grep -q "keep .*lane-unpushed.*1 unpushed" "$work/plan.log" || { cat "$work/plan.log"; fail 'plan did not keep lane-unpushed'; }
grep -q "convert .*lane-a " "$work/plan.log" || { cat "$work/plan.log"; fail 'plan did not convert lane-a'; }
pass 'plan classifies held, unpushed, released and clean worktrees, and skips a broken link with a warning'

as_owner bash "$here/migrate.sh" convert > "$work/convert.log" 2> "$work/convert.err" || { cat "$work/convert.err"; fail 'convert failed'; }
grep -q "skipped $broken: " "$work/convert.err" || { cat "$work/convert.err"; fail 'convert did not warn of the broken worktree link'; }
converted=$home/.local/state/workbox-btrfs/converted.tsv
[[ $(cut -f1 "$converted" | sort | tr '\n' ' ') == 'lane-a lane-clean lane-detached ' ]] || { cat "$converted"; fail 'converted the wrong worktrees'; }
ra=$ws/.rifts/app/lane-a
[[ $(git -C "$ra" log -1 --format=%s) == 'lane a' ]] || fail 'lane-a commit did not reach its Rift'
git -C "$ra" diff --cached --name-only | grep -qx src/staged.ts || fail 'staged work lost'
grep -q 'a = 2' "$ra/src/index.ts" || fail 'unstaged work lost'
[[ $(cat "$ra/notes.md") == untracked ]] || fail 'untracked file lost'
[[ $(git -C "$ws/.rifts/app/detached-lane-detached" log -1 --format=%s) == 'detached work' ]] || fail 'detached worktree lost its commit'
as_owner bash "$here/migrate.sh" convert > /dev/null 2>&1 || fail 'a rerun of convert failed'
[[ $(wc -l < "$converted") == 3 ]] || fail 'a rerun of convert converted again'
pass 'convert makes Rifts with commits, staged, unstaged and untracked work; reruns are no-ops'

# --- The owner grows the disk; grow.sh grows ext4 and the image.
truncate -s 6G "$disk_file"
losetup -c "$disk"
bash "$here/grow.sh" > "$work/grow.log"
ext4=$(df -B1 --output=size "$root" | awk 'NR == 2 { print $1 }')
((ext4 > 5 * 1073741824)) || fail "ext4 did not grow ($ext4)"
size=$(stat -c %s "$image")
alloc=$(($(stat -c %b "$image") * 512))
free=$(df -B1 --output=avail "$root" | awk 'NR == 2 { print $1 }')
((size > 1073741824)) || fail 'image did not grow'
((size - alloc <= free - 1073741824)) || fail 'the image may grow past ext4 free space minus the headroom'
btrfs_size=$(btrfs filesystem usage -b "$ws" | awk '/Device size/ { print $3; exit }')
[[ $btrfs_size == "$size" ]] || fail "btrfs spans $btrfs_size, image is $size"
read -r blocks reserved < <(dumpe2fs -h "$disk" 2>/dev/null | awk -F: '/^Block count/ { b = $2 } /^Reserved block count/ { r = $2 } END { print b + 0, r + 0 }')
((reserved * 100 <= blocks + blocks / 100)) || fail "ext4 still reserves $reserved of $blocks blocks"
# A rerun grows at most by the rounding: allocated + free stays the same.
bash "$here/grow.sh" > "$work/grow2.log" 2>&1 || { cat "$work/grow2.log"; fail 'a second grow.sh failed'; }
size2=$(stat -c %s "$image")
((size2 >= size && size2 - size <= 1073741824)) || { cat "$work/grow.log" "$work/grow2.log"; fail "a second grow.sh moved the image from $size to $size2"; }
pass "grow.sh grew ext4 to $((ext4 >> 20)) MiB and btrfs to $((size >> 20)) MiB, leaving the headroom"

# --- home: refuses while a process uses the home, then swaps.
(cd "$app" && exec sleep 300) &
holder_pid=$!
sleep 0.5
if WB_IDLE_WAIT=2 bash "$here/migrate.sh" home > "$work/home-busy.log" 2>&1; then fail 'home ran while a process used the home'; fi
grep -q 'sleep (pid' "$work/home-busy.log" || { cat "$work/home-busy.log"; fail 'home did not name the busy process'; }
[[ ! -e $home.pre-btrfs ]] || fail 'a refused run moved the home'
pass 'home refuses and names the process while the home is in use'

# --stop that fails (the holder outlives the stop): the trap lifts the login block.
if env "${stop_env[@]}" WB_IDLE_WAIT=2 bash "$here/migrate.sh" home --stop > "$work/home-stop-busy.log" 2>&1; then fail 'home --stop ran while a process used the home'; fi
grep -q 'login refused' "$fake/log" || { cat "$fake/log"; fail 'home --stop did not block logins during the window'; }
block_lifted || { cat "$fake/log"; fail 'a failed home --stop left /run/nologin or user@ masked'; }
[[ ! -e $home.pre-btrfs ]] || fail 'a refused run moved the home'
pass 'a failed home --stop lifts the login block on exit'

# Killed during the window (TERM): the block is lifted too.
: > "$fake/log"
env "${stop_env[@]}" WB_IDLE_WAIT=60 bash "$here/migrate.sh" home --stop > "$work/home-stop-term.log" 2>&1 &
stop_pid=$!
for _ in $(seq 1 100); do grep -q 'Waiting for' "$work/home-stop-term.log" && break; sleep 0.2; done
[[ -e $root/run/nologin ]] || { cat "$work/home-stop-term.log"; fail 'no /run/nologin during the window'; }
kill -TERM "$stop_pid"; wait "$stop_pid" 2>/dev/null || true
block_lifted || { cat "$fake/log"; fail 'a killed home --stop left /run/nologin or user@ masked'; }
pass 'a killed home --stop lifts the login block'
kill "$holder_pid"; wait "$holder_pid" 2>/dev/null || true; holder_pid=

: > "$fake/log"
env "${stop_env[@]}" bash "$here/migrate.sh" home --stop > "$work/home.log" 2>&1 || { cat "$work/home.log"; fail 'home failed'; }
no_login_in_window || { cat "$fake/log"; fail 'a login during the window started user@'; }
grep -q 'login refused' "$fake/log" || { cat "$fake/log"; fail 'the login in the window was not refused'; }
grep -q '^started user@' "$fake/log" || { cat "$fake/log"; fail 'home --stop did not start user@ again'; }
block_lifted || fail 'home --stop left the login block'
pass 'home --stop keeps logins out during the window and starts user@ after'
[[ $(findmnt -n -o FSROOT --mountpoint "$home") == /@home ]] || fail 'home is not @home'
[[ $(findmnt -n -o FSROOT --mountpoint "$root/tmp") == /@tmp ]] || fail '/tmp is not @tmp'
cmp -s "$home/.cache/big" <(head -c $((1536 << 20)) /dev/zero) || fail 'the large file changed'
[[ $(cat "$root/tmp/agent-scratch") == scratch ]] || fail '/tmp content was not carried'
[[ ! -e $root/tmp/systemd-private-x ]] || fail 'a service private /tmp was copied'
[[ $(stat -c %a "$root/tmp") == 1777 ]] || fail '/tmp lost its mode'
[[ $(stat -c %U "$home/.cache/blob") == "$user" ]] || fail 'owner lost'
[[ $(stat -c %i "$app/node_modules/pkg/index.js") == $(stat -c %i "$home/.bun/install/cache/pkg/index.js") ]] || fail 'bun hard link split'
[[ ! -e $wt/lane-a ]] || fail 'a converted worktree was copied'
[[ $(cat "$broken/file") == kept ]] || fail 'the broken worktree link was not copied as it is'
grep -q "warn .*$broken .*broken before the migration" "$work/home.log" || { cat "$work/home.log"; fail 'check.sh did not report the link broken before the migration'; }
[[ -d $wt/lane-held && -d $wt/lane-unpushed ]] || fail 'a kept worktree is missing'
as_owner git -C "$wt/lane-held" status --short >/dev/null || fail 'a kept worktree lost its repository'
[[ $(grep -c 'subvol=@' "$root/etc/fstab") == 2 ]] || fail 'fstab lines missing'
grep -q 'cp --reflink=always works' "$work/home.log" || fail 'no reflinks under the new home'
pass "home moved the home and /tmp onto subvolumes (inode was $before_inode; links, owners, modes kept)"

bash "$here/migrate.sh" home > /dev/null || fail 'a rerun of home failed'
[[ $(grep -c 'subvol=@' "$root/etc/fstab") == 2 ]] || fail 'a rerun added fstab lines'
pass 'home reruns as a no-op'

# Root without sudo's SUDO_UID, as under systemd-run on the workbox: git trusts
# a repository root does not own only through SUDO_UID, so check.sh must read
# the owner's Rifts as the owner.
env -u SUDO_UID -u SUDO_GID -u SUDO_USER bash "$here/check.sh" > "$work/check-nosudo.log" 2>&1 ||
    { cat "$work/check-nosudo.log"; fail 'check.sh as plain root fails on the owner-owned Rifts'; }
grep -q 'ok    lane-a is the Rift' "$work/check-nosudo.log" || { cat "$work/check-nosudo.log"; fail 'check.sh did not check the Rifts'; }
pass 'check.sh reads the owner-owned Rifts as the owner'

# --- check.sh's alarms. An image that may grow past ext4's free space: only the
# file's apparent size changes (no losetup -c), so btrfs never sees it.
size_ok=$(stat -c %s "$image")
free=$(df -B1 --output=avail "$root" | awk 'NR == 2 { print $1 }')
truncate -s $((size_ok + free + 1073741824)) "$image"
bash "$here/check.sh" > "$work/check-unbacked.log" 2>&1 || true
truncate -s "$size_ok" "$image"
grep -q 'warn .*could fill the root' "$work/check-unbacked.log" || { cat "$work/check-unbacked.log"; fail 'check.sh did not warn of an image ext4 cannot back'; }
bash "$here/check.sh" | grep -q 'could fill the root' && fail 'check.sh warns of a backed image'
pass 'check.sh warns when the image may outgrow ext4 free space, and only then'

# A subvolume line above the image line, in a copy of the fstab.
bad_fstab=$work/fstab.misordered
{ grep 'subvol=@home,' "$root/etc/fstab"; grep -v 'subvol=@home,' "$root/etc/fstab"; } > "$bad_fstab"
if WB_FSTAB=$bad_fstab bash "$here/check.sh" > "$work/check-order.log" 2>&1; then
    cat "$work/check-order.log"; fail 'check.sh passed an fstab with @home before the image'
fi
grep -q 'FAIL  @home line comes before the image line' "$work/check-order.log" || { cat "$work/check-order.log"; fail 'check.sh did not name the misordered @home line'; }
pass 'check.sh fails an fstab that mounts a subvolume before the image'

# A link the move broke still fails; only the recorded ones are warnings.
mv "$app/.git/worktrees/lane-held" "$work/lane-held-gitdir"
if bash "$here/check.sh" > "$work/check-link.log" 2>&1; then lane_rc=0; else lane_rc=1; fi
mv "$work/lane-held-gitdir" "$app/.git/worktrees/lane-held"
((lane_rc == 1)) && grep -q "FAIL  $wt/lane-held points at a missing" "$work/check-link.log" ||
    { cat "$work/check-link.log"; fail 'check.sh passed a worktree link broken after the migration'; }
pass 'check.sh fails a newly broken worktree link and only warns of one broken before'

# --- finish: prunes, deletes the old trees, grows the image into the space.
size_before=$(stat -c %s "$image")
bash "$here/migrate.sh" finish > "$work/finish-dry.log" 2>&1 || { cat "$work/finish-dry.log"; fail 'finish (dry) failed'; }
[[ -d $home.pre-btrfs ]] || fail 'finish without --yes deleted the old home'
bash "$here/migrate.sh" finish --yes > "$work/finish.log" 2>&1 || { cat "$work/finish.log"; fail 'finish failed'; }
[[ ! -e $home.pre-btrfs ]] || fail 'old home not deleted'
list=$(as_owner git -C "$app" worktree list)
grep -q lane-a <<< "$list" && fail 'converted worktree entry not pruned'
grep -q stale-base <<< "$list" && fail 'stale worktree entry not pruned'
grep -q lane-held <<< "$list" || fail 'a kept worktree entry was pruned'
mkdir "$work/peek"
mount --bind "$root" "$work/peek"
[[ -z $(ls -A "$work/peek/tmp") ]] || fail 'old /tmp under the mount not cleared'
umount "$work/peek"
(($(stat -c %s "$image") > size_before)) || fail 'finish did not grow the image into the freed space'
pass 'finish prunes worktree entries, deletes the old home and /tmp, and grows the image'
[[ -z ${WB_TEST_VERBOSE:-} ]] || cat "$work/plan.log" "$work/grow.log" "$work/home.log" "$work/finish.log"
echo 'test.sh: all passed'
