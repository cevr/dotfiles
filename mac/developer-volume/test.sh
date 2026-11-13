#!/usr/bin/env bash
# Runs `migrate.sh preflight` and `migrate.sh copy` from a scratch tree onto a scratch
# APFS disk image, then `check.sh` on the image. Needs no sudo; setup.sh itself is not
# covered (it needs a real volume), and neither is mdutil -i off (it needs root).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd -P)
work=$(mktemp -d)
work=$(cd "$work" && pwd -P)
src=$work/src
# The image mounts at a scratch home's Developer, so check.sh's ~/Developer checks run.
home=$work/home
mnt=$home/Developer
started=()
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
# Stops the processes this test started, by the pids it holds.
stop_started() {
    local pid
    for pid in ${started[@]+"${started[@]}"}; do kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; done
    started=()
}
cleanup() {
    stop_started
    hdiutil detach -quiet "$mnt" 2>/dev/null || true
    rm -rf "$work"
}
trap cleanup EXIT

npm_time=198510260815 # npm writes this mtime into every package file
git_() { git -c user.name=t -c user.email=t@t -c init.defaultBranch=main "$@" >/dev/null 2>&1; }

# Main checkout with a large file, a package, a submodule link and xattrs.
app=$src/personal/app
mkdir -p "$app/src" "$app/node_modules/pkg" "$app/vendor/sub"
head -c $((64 * 1024 * 1024)) /dev/urandom > "$app/big.bin"
echo 'export const a = 1' > "$app/src/index.ts"
echo 'gone' > "$app/src/removed.ts"
echo '{"version":"1.2.3"}' > "$app/node_modules/pkg/package.json"
touch -t "$npm_time" "$app/node_modules/pkg/package.json"
echo 'gitdir: ../../.git/modules/sub' > "$app/vendor/sub/.git"
xattr -w com.example.tag kept "$app/src/index.ts"
echo shared > "$app/link-a" && ln "$app/link-a" "$app/link-b"
git_ -C "$app" init
git_ -C "$app" add src
git_ -C "$app" commit -m init

# A git worktree whose other files are clones of the main checkout.
feature=$src/personal/.rifts/app/feature
git_ -C "$app" worktree add "$feature" -b feature
for entry in "$app"/node_modules "$app"/big.bin "$app"/link-a "$app"/link-b; do cp -c -p -R "$entry" "$feature/"; done
echo 'export const a = 2' > "$feature/src/index.ts"
rm "$feature/src/removed.ts"
echo 'new' > "$feature/src/added.ts"
# Same size, same mtime, different bytes: only a checksum tells them apart.
echo '{"version":"1.2.4"}' > "$feature/node_modules/pkg/package.json"
touch -t "$npm_time" "$feature/node_modules/pkg/package.json"

# A worktree inside its own main checkout must not be cloned into itself.
git_ -C "$app" worktree add "$app/.worktrees/inner" -b inner
cp -c -p "$app/big.bin" "$app/.worktrees/inner/"

# A non-git rift, known only to rift's database.
notes=$src/personal/notes
draft=$src/personal/.rifts/notes/draft
mkdir -p "$notes" "$draft"
head -c $((32 * 1024 * 1024)) /dev/urandom > "$notes/scan.bin"
cp -c -p "$notes/scan.bin" "$draft/"
echo 'draft' > "$draft/todo.md"
db=$work/rift.sqlite
sqlite3 "$db" "create table rift (id text primary key, parent_id text, path text not null unique, created_at integer not null);
    insert into rift values ('p', null, '$notes', 0), ('c', 'p', '$draft', 0);"

# Today's rifts: full clones, their own .git directory included, known to rift's
# database; a rift of a rift; and a work rift under work/.rifts.
lib=$src/personal/lib
mkdir -p "$lib"
git_ -C "$lib" init
echo 'lib' > "$lib/lib.ts"
git_ -C "$lib" add lib.ts
git_ -C "$lib" commit -m init
head -c $((32 * 1024 * 1024)) /dev/urandom > "$lib/.git/objects/big.pack"
r1=$src/personal/.rifts/lib/r1
r2=$src/personal/.rifts/lib/r2
mkdir -p "${r1%/*}"
cp -c -p -R "$lib" "$r1"
cp -c -p -R "$r1" "$r2"
echo 'lib 2' > "$r2/lib.ts"
bite=$src/work/bite
wrift=$src/work/.rifts/bite/w1
mkdir -p "$bite" "${wrift%/*}"
head -c $((16 * 1024 * 1024)) /dev/urandom > "$bite/bundle.bin"
cp -c -p -R "$bite" "$wrift"
sqlite3 "$db" "insert into rift values ('l', null, '$lib', 0), ('l1', 'l', '$r1', 0), ('l2', 'l1', '$r2', 0),
    ('b', null, '$bite', 0), ('b1', 'b', '$wrift', 0);"

# A removed rift waiting for gc, and a worktree whose main checkout is elsewhere.
mkdir -p "$src/personal/.rifts/app/.trash/old"
echo junk > "$src/personal/.rifts/app/.trash/old/junk"
mkdir -p "$src/work/stray"
echo "gitdir: $work/elsewhere/.git/worktrees/stray" > "$src/work/stray/.git"
echo stray > "$src/work/stray/file"
# Enough directories for the after check's 38 watches.
for i in $(seq 1 40); do mkdir -p "$src/personal/many/d$i"; done

# preflight: a shell inside the tree and a process with a file of it open both block.
(cd "$src/work" && exec sleep 60) &
cwd_pid=$!
tail -f "$app/src/index.ts" > /dev/null &
file_pid=$!
started=("$cwd_pid" "$file_pid")
sleep 0.5
if out=$("$here/migrate.sh" preflight "$src" 2>&1); then fail "preflight passed while pids $cwd_pid and $file_pid used the tree"; fi
grep -q "pid $cwd_pid " <<< "$out" || fail "preflight missed the shell inside the tree: $out"
grep -q "pid $file_pid " <<< "$out" || fail "preflight missed the open file: $out"
grep -q 'quit ' <<< "$out" || fail "preflight printed nothing to quit: $out"
stop_started
"$here/migrate.sh" preflight "$src" > /dev/null || fail 'preflight still blocked once its holders quit'

# launchd-due: an agent whose script imports from the tree and fires inside the window
# is due; one naming the tree in its plist but firing after the window is "later"; one
# that never refers to the tree is not listed.
agents=$work/agents
mkdir -p "$agents"
echo "import { scheduled } from \"$src/personal/dotfiles/backstop.ts\"" > "$work/job.ts"
plist() {
    plutil -create xml1 "$agents/$1.plist"
    plutil -insert Label -string "$1" "$agents/$1.plist"
    plutil -insert ProgramArguments -array "$agents/$1.plist"
    plutil -insert ProgramArguments -string /usr/bin/true -append "$agents/$1.plist"
    plutil -insert ProgramArguments -string "$2" -append "$agents/$1.plist"
    plutil -insert StartCalendarInterval -json "$3" "$agents/$1.plist"
}
plist test.nightly "$work/job.ts" '{"Hour":3,"Minute":15}'
plist test.monday "$src/personal/x.sh" '{"Weekday":1,"Hour":9,"Minute":0}'
plist test.other /usr/bin/true '{"Hour":3,"Minute":15}'
# Saturday 2026-11-14 16:25 local; 36 hours reach Monday 04:25.
window=$(date -j -f '%Y-%m-%d %H:%M:%S' '2026-11-14 16:25:00' +%s)
due=$(bun "$here/launchd-due.ts" "$src" 36 "$agents" "$window")
nightly=$(awk -F '\t' '$1 == "test.nightly" { print $3 }' <<< "$due")
[[ $nightly == "$(date -u -r "$(date -j -f '%Y-%m-%d %H:%M:%S' '2026-11-15 03:15:00' +%s)" +%Y-%m-%dT%H:%M:00.000Z)" ]] || fail "nightly agent not due Sunday 03:15: $due"
grep -q $'^test.monday\tunloaded\tlater\t' <<< "$due" || fail "monday agent should be later: $due"
grep -q '^test.other' <<< "$due" && fail "an agent that never refers to the tree was listed: $due"

hdiutil create -quiet -size 1g -fs APFS -type SPARSE -volname devtest "$work/img"
mkdir -p "$mnt"
hdiutil attach -quiet -nobrowse -mountpoint "$mnt" "$work/img.sparseimage"
before=$(df -k "$mnt" | awk 'NR == 2 { print $3 }')

run() { DEVELOPER_MIGRATE_RIFT_DB=$db DEVELOPER_MIGRATE_RESERVE_KB=1024 "$here/migrate.sh" copy "$src" "$src" "$mnt"; }
run
used=$(($(df -k "$mnt" | awk 'NR == 2 { print $3 }') - before))

diff -r -x .trash -x .fseventsd -x .Spotlight-V100 -x .Trashes -x .TemporaryItems "$src" "$mnt" || fail 'copy differs from source'
[[ ! -e $mnt/personal/.rifts/app/.trash ]] || fail 'rift trash was copied'
grep -q 1.2.4 "$mnt/personal/.rifts/app/feature/node_modules/pkg/package.json" || fail 'same-size package file kept the main checkout bytes'
[[ ! -e $mnt/personal/.rifts/app/feature/src/removed.ts ]] || fail 'file deleted in worktree came back'
[[ $(xattr -p com.example.tag "$mnt/personal/app/src/index.ts") == kept ]] || fail 'extended attribute lost'
[[ $(stat -f %i "$mnt/personal/app/link-a") == $(stat -f %i "$mnt/personal/app/link-b") ]] || fail 'hard link split'
[[ ! -e $mnt/personal/app/.worktrees/inner/.worktrees ]] || fail 'worktree cloned into itself'
[[ $(cat "$mnt/personal/.rifts/lib/r2/lib.ts") == 'lib 2' ]] || fail 'rift of a rift kept its parent bytes'
git -C "$mnt/personal/.rifts/lib/r2" rev-parse HEAD > /dev/null 2>&1 || fail 'rift .git directory is not a repository'
# Unshared: 64 MiB x3, 32 MiB x2 (notes), 32 MiB x3 (lib .git), 16 MiB x2 (work) = 384 MiB.
# Shared: 64 + 32 + 32 + 16 = 144 MiB.
((used < 190 * 1024)) || fail "clones were not shared: $((used / 1024)) MiB used"

run > /dev/null || fail 'rerun failed'

# A cache moves onto the volume behind a link; the old directory goes to the Trash.
cache=$home/.cache/repo
mkdir -p "$cache/github/x" "$work/trash"
echo src > "$cache/github/x/a.ts"
move() { DEVELOPER_MIGRATE_TRASH=$work/trash DEVELOPER_MIGRATE_RESERVE_KB=1024 "$here/migrate.sh" move-cache "$cache" "$mnt/.cache/repo" > /dev/null; }
move || fail 'move-cache failed'
[[ -L $cache && $(readlink "$cache") == "$mnt/.cache/repo" ]] || fail 'cache was not linked onto the volume'
[[ $(cat "$cache/github/x/a.ts") == src ]] || fail 'cache contents did not move'
compgen -G "$work/trash/repo-pre-volume-*" > /dev/null || fail 'old cache did not go to the Trash'
move || fail 'move-cache rerun failed'
# Interrupted after the old directory left and before the link: the rerun links it.
rm "$cache"
move || fail 'move-cache resume failed'
[[ -L $cache ]] || fail 'move-cache resume did not link the cache'
# A cache larger than the free space past the reserve is refused before anything moves.
big=$home/.bun/install/cache
mkdir -p "$big"
head -c $((8 * 1024 * 1024)) /dev/urandom > "$big/pkg.tgz"
reserve=$(($(df -kP "$mnt" | awk 'NR == 2 { print $4 }') - 4096))
if DEVELOPER_MIGRATE_TRASH=$work/trash DEVELOPER_MIGRATE_RESERVE_KB=$reserve "$here/migrate.sh" move-cache "$big" "$mnt/.cache/bun" 2> /dev/null; then
    fail 'move-cache moved a cache past the free-space reserve'
fi
[[ -d $big && ! -L $big && ! -e $mnt/.cache/bun ]] || fail 'refused move-cache changed something'
rm -r "$home/.bun"

# The after check on the image. mdutil -i off needs root, so the image keeps an
# unknown indexing state and that one check must fail; the others must pass.
mkdir -p "$mnt/.fseventsd" "$home/.config"
touch "$mnt/.fseventsd/no_log"
# A dotfiles-style link into ~/Developer, recorded before the move as migrate.sh does.
ln -s "$mnt/personal/app" "$home/.config/app"
check() { HOME=$home DEVELOPER_VOLUME_STATE=$work/state DEVELOPER_CHECK_SAMPLE_S=1 "$here/check.sh" "$@"; }
check --links | grep -q '^1 links' || fail 'check.sh --links did not record the one link'
check --baseline > /dev/null || fail 'check.sh --baseline failed'
if out=$(check); then fail "after check passed with Spotlight not turned off: $out"; fi
for name in volume no_log watch links; do grep -q "^ok  *$name " <<< "$out" || fail "after check: $name did not pass: $out"; done
grep -q '^FAIL  *mdutil ' <<< "$out" || fail "after check: mdutil did not fail: $out"
grep -q '^info  *fseventsd  *after: .*before: [0-9]' <<< "$out" || fail "after check: no fseventsd before/after: $out"
rm "$mnt/.fseventsd/no_log" "$home/.config/app"
out=$(check) || true
grep -q '^FAIL  *no_log ' <<< "$out" || fail "after check missed a missing no_log: $out"
grep -q "^FAIL  *links  *$home/.config/app (recorded before the move) is gone" <<< "$out" || fail "after check missed a lost link: $out"
echo "ok: preflight blocks on holders; copy verified, clones shared ($((used / 1024)) MiB used for 384 MiB of files); caches move behind a link; after check reads volume, no_log, mdutil, watch, links and fseventsd"
