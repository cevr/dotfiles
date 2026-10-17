#!/usr/bin/env bash
# Runs `migrate.sh copy` from a scratch tree onto a scratch APFS disk image.
# Needs no sudo; setup.sh itself is not covered (it needs a real volume).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd -P)
work=$(mktemp -d)
work=$(cd "$work" && pwd -P)
src=$work/src
mnt=$work/mnt
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
cleanup() {
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

# A rift: git worktree whose other files are clones of the main checkout.
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

# A removed rift waiting for gc, and a worktree whose main checkout is elsewhere.
mkdir -p "$src/personal/.rifts/app/.trash/old"
echo junk > "$src/personal/.rifts/app/.trash/old/junk"
mkdir -p "$src/work/stray"
echo "gitdir: $work/elsewhere/.git/worktrees/stray" > "$src/work/stray/.git"
echo stray > "$src/work/stray/file"

hdiutil create -quiet -size 1g -fs APFS -type SPARSE -volname devtest "$work/img"
mkdir "$mnt"
hdiutil attach -quiet -nobrowse -mountpoint "$mnt" "$work/img.sparseimage"
before=$(df -k "$mnt" | awk 'NR == 2 { print $3 }')

run() { DEVELOPER_MIGRATE_RIFT_DB=$db DEVELOPER_MIGRATE_RESERVE_KB=1024 "$here/migrate.sh" copy "$src" "$src" "$mnt"; }
run
used=$(( $(df -k "$mnt" | awk 'NR == 2 { print $3 }') - before ))

diff -r -x .trash -x .fseventsd -x .Spotlight-V100 -x .Trashes -x .TemporaryItems "$src" "$mnt" || fail 'copy differs from source'
[[ ! -e $mnt/personal/.rifts/app/.trash ]] || fail 'rift trash was copied'
grep -q 1.2.4 "$mnt/personal/.rifts/app/feature/node_modules/pkg/package.json" || fail 'same-size package file kept the main checkout bytes'
[[ ! -e $mnt/personal/.rifts/app/feature/src/removed.ts ]] || fail 'file deleted in worktree came back'
[[ $(xattr -p com.example.tag "$mnt/personal/app/src/index.ts") == kept ]] || fail 'extended attribute lost'
[[ $(stat -f %i "$mnt/personal/app/link-a") == $(stat -f %i "$mnt/personal/app/link-b") ]] || fail 'hard link split'
[[ ! -e $mnt/personal/app/.worktrees/inner/.worktrees ]] || fail 'worktree cloned into itself'
# Unshared, the three 64 MiB and two 32 MiB copies take 256 MiB; shared, 96.
((used < 140 * 1024)) || fail "clones were not shared: $((used / 1024)) MiB used"

run >/dev/null || fail 'rerun failed'
echo "ok: copy verified, clones shared ($((used / 1024)) MiB used for 256 MiB of files)"
