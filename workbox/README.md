# Bite workbox

This directory defines the persistent workflow layer for the Bite workbox
(today the exe.dev VM `bite-cristian`; from December the Hetzner AX102 that
`linux/hetzner-workbox/` provisions).

## Apply

Run this command on the workbox:

```sh
~/Developer/personal/dotfiles/workbox/bootstrap.sh
```

Run this command to verify the installed state:

```sh
~/Developer/personal/dotfiles/workbox/bootstrap.sh --check
```

The base box must already have Bun and the Bun CLIs in `~/.bun` (Sideshow,
Hunk, Codex), Claude, MongoDB, Redis, Syncthing, Tailscale, and the Bite
repository; on the Hetzner box they come with the synced home. The bootstrap
installs the workbox shell and scripts, herdr-core (`hc`) when it is missing,
Sideshow, agent settings, S3 backups, security updates, the Tailscale SSH
service, and swap protection. It configures `systemd-resolved` with public
fallback servers. It protects Tailscale, the DNS resolver, and the Tailscale SSH
service from workload memory pressure. It caps user sessions, which hold the
terminals and every agent, at 52 GB of memory and 1 GB of swap. It caps
`/dev/shm` at 8 GB because no process owns its files and the kernel cannot
reclaim them. It starts the herdr-core core and the OpenCode service at boot. It
uses `/workspaces/.cache/turbo` as a local Turbo cache.

## Terminals: herdr-core

herdr-core (`hc`, herdr.dev/core) holds the workbox's terminals. Its core
(`herdr-core serve`) runs in a transient user unit that hc makes itself,
`hc-serve-<hash>.service` in `app.slice`, with `OOMPolicy=continue` and
`KillMode=process`: the core keeps running when the kernel kills a terminal's
program for memory, and each terminal's holder (`herdr-core hold`, in its own
`hc-hold-<hash>.service`) keeps its program running through a core restart.
Linger is on, so the core outlives every login.

A transient unit is gone after a reboot. `hc-core.service`, a oneshot enabled at
`default.target`, runs `hc server start` at boot; hc moves the core into its own
unit and the oneshot exits, so the core never lives in `hc-core.service`'s
cgroup. Kept terminals (`hc keep`) come back as shells. `hc server start` leaves
a running core alone, so starting the unit again is safe. Update hc with
`hc update`; terminals keep running.

Reach it with `ssh -t bite-workbox hc` (hc's picker, any client), or from the
Mac with `--on workbox` and addresses such as `workbox/t7` once
`hc machine add bite-workbox --name workbox` has run there.

`opencode.service`, also a oneshot at `default.target`, runs
`opencode service start` at boot; the server moves itself into its own scope.

`herdr-config.toml` is the Mac's herdr config (`install.sh` links it).

## Timers

| Timer | Runs |
| --- | --- |
| `workbox-backup.timer` | `backup-state` each day at 02:30 |
| `transcript-archive.timer` | Claude and Codex transcripts to the R2 archive each day at 03:15 |
| `claude-daily.timer` | `claude/bin/claude-daily-install` each day at 05:10: the latest Claude Code, its release recorded for the OpenCode launcher |
| `cull-transcript-images.timer` | replaces transcript images with a note each Sunday |
| `cleanup-mosh-servers.timer` | signals disconnected Mosh servers every 15 minutes |

## S3 backups

The backup timer writes private encrypted objects to
`s3://bite-workbox-backups-251766048541/snapshots/`.

The command uses the `bite-dev` AWS SSO profile. It uploads each snapshot,
downloads the object, checks its SHA-256 value, and then removes its temporary
local files. AWS SSO must remain valid on the workbox.

The bucket blocks public access. It enables versioning and deletes current and
noncurrent snapshot objects after 14 days.

## Commands

- `workbox-rift-storage` creates or checks the Btrfs workspace file system.
- `workrift init <repository> [path]` clones a repository as a warm source (a base).
- `workrift create <branch>` creates a complete isolated workspace from the warm
  source. It checks out the remote branch when one exists, and otherwise starts
  a new branch from the freshly fetched remote default branch.
- `workrift deps` installs dependencies in the current checkout when its lock
  file or a dependency patch in `patches/` changed since the last install.
- `workrift refresh` updates and warms the source from its default branch.
- `workrift list` lists the source's workspaces; `workrift sources` lists sources.
- `workrift remove [--dry-run] [--with-children] [path]` deletes a workspace for
  good: the workbox keeps no trash (owner, 2026-11-19). It refuses a workspace
  with uncommitted changes, stash entries or unpushed commits, one a process
  works in, and one with child workspaces unless you pass `--with-children`.
  After `work rm` it has work delete each record it trashed, by
  `work gc -id <id>`, and only once each trash folder is checked to sit beside
  that workspace; otherwise, or if that gc fails, it names the trash and exits
  1. `--dry-run` prints the folders it would delete. Off Linux (or with
  `WORKRIFT_PURGE=0`) the workspace stays in work's trash; the Rift backend
  (`.rifts/`, rollback only) still trashes with `rift remove`. A commit
  counts as unpushed only after a fetch of origin (a land pushes main from
  another workspace), and a clean merge of pushed parents counts as none.
  A half-made workspace (a create cut mid-way: a folder in `.work/<repo>/` with
  no `.git` and no record) is removed by its exact absolute path: remove says
  what it is and deletes it for good (one `btrfs subvolume delete` when it is
  a subvolume), and refuses any other folder, a mount, a link, one a process
  uses, and one while a create holds the base's lock. When the cut create
  left its record in state Creating, remove takes it only on shown proof (no
  `.git`, the record at least an hour old, its maker's reservation lock free)
  and through work's own `work gc -id <id>`, which drops the record with the
  folder; a Creating record over a folder with a `.git` is a live lane with a
  stale record, and is refused.
- `workrift prune [--dry-run]` archives and removes workspaces idle for two days.
- In OpenCode, the `work` tool runs these for an agent: `create`, `list`,
  `remove` and `land` on any host, and `init`, `refresh`, `deps`, `check`,
  `sources`, `prune` (only `--dry-run`) and `storage` here. It answers to
  `rift` as an alias until 2026-12-06; `workrift` keeps its name until then.
- `workbox-port <port>` prints the private URL for a running HTTP server.
- `backup-state` creates and verifies an S3 state snapshot.
- `install-node` installs the exact Node version from `package.json`.
- `apply-agent-settings` links the shared Claude and Codex settings and
  installs the synced local ones; `bite-agent-settings.path` runs it when they
  change, and the fleet update runs it through `install-bin.sh --apply`.
- `trash` moves files to the home trash, across Btrfs subvolumes.
- `cleanup-mosh-servers` removes disconnected Mosh servers.

## Workspaces

`workrift` makes workspaces with Rift or with Ergo's `work`: the file
`~/.config/workrift/backend` holds `rift` or `work` (absent: `rift`). The
workbox runs `work`: a warm source is a work base, and its workspaces go to
`.work/<source>/<branch>` next to it; the Rift details below hold for the older
workspaces under `.rifts/`.

On the exe.dev VM the root file system stays on ext4 and the workspace file
system uses Btrfs inside `/var/lib/bite-workspaces.btrfs`, mounted through
`/etc/fstab` at `/workspaces`; on the Hetzner box `/workspaces` is a subvolume
of the root Btrfs. On the VM the image's `@home` and `@tmp` mount from the image
file too, with `loop` (mount reuses `/workspaces`' loop device), never by
`UUID=`: systemd-udevd is masked there, so a `/dev/disk/by-uuid` link never
appears and a `UUID=` line fails the boot after 90 s (2026-11-19).
`workbox-rift-storage --apply` (bootstrap) rewrites such lines, and
`workbox-rift-storage --fstab` does only that; `--check` fails while one is left.
`workbox-btrfs-reclaim.service` turns on btrfs dynamic reclaim
(`allocation/data/dynamic_reclaim`) at each boot for the file system mounted at
`/workspaces`, found by its device, so nearly empty data chunks go back to
unallocated space that metadata can grow into.

Each repository has one clean warm source, such as `/workspaces/bite`. Do not
use a warm source for feature work. `workrift` finds the source from the current
directory: the Rift root of a workspace, or the source with the same `origin` as
a normal checkout. Set `WORKRIFT_SOURCE` to choose one explicitly.

`workrift create` first fast-forwards the source to the fetched default branch
and warms it, so the snapshot holds today's tree and the branch switch rewrites
only the branch's own changes; unchanged files keep sharing blocks with the
source. A lock on the source's Git directory serializes `create` and `refresh`.
It then takes a writable Btrfs snapshot with dependencies and compiled
outputs, and creates or selects the requested Git branch, and runs the
install only when the branch's lock file differs from the last install. When the
command runs from a matching stacked checkout, it also imports `.git/gh-stack`.
`init`, `create`, `refresh` and `deps` run themselves at nice 10, and in the
idle I/O class (`ionice -c3`) where `ionice` is, so their clones, fetches,
checkouts and installs yield to the OpenCode service.
Run `gh stack checkout <PR>` in the workspace when imported metadata needs a refresh.

A branch change inside a workspace can also change the lock file. For a
repository with `lefthook.yml`, `workrift` writes an untracked
`lefthook-local.yml` in the source that runs `workrift deps` after checkout,
merge and rewrite. `.git/info/exclude` hides the file, and `--copy-all` copies
it into every workspace. The same moves make the build output stale, so
`workrift deps` also runs the warm step when HEAD's tree differs from the tree
the last warm step built. The warm runs in the foreground: it prints one line
before it starts and one with its result, and its output goes to
`.git/workrift-warm.log`. `WORKRIFT_WARM=0` skips the warm alone. It does not
run on an unborn branch, or while a rebase, merge, cherry-pick, revert or bisect
is in progress (a path checkout mid-rebase runs post-checkout over conflict
markers); post-rewrite passes `rebase` at a rebase's end, so a rebase builds
once, there, and a rebase that only moves HEAD (its todo list empty, so no
post-rewrite comes) builds at its post-checkout. An amend builds nothing, like
the commit before it. `deps` also brings a workspace's managed
`lefthook-local.yml` up to date, so a workspace made before a change to it gets
today's jobs at its next hook. A warm that fails clears the marker, since it
may have left the output half gone. `git reset`, `git commit`, `git cherry-pick` and
`git rebase --abort` run no hook, so run `workrift deps` by hand after them. The
last installed lock fingerprint is in `.git/workrift-installed-locks`, the last
warmed tree in `.git/workrift-warmed-tree`.

A source's Git config holds its settings: `workrift.main` (default branch),
`workrift.install` (default: from the lock file) and `workrift.warm` (a build
step after the install). `refresh` runs it in the source. `create` runs it in the
new workspace unless the branch's tree is the source's, because the copied build
output matches the source's tree, not the branch; a failed step only prints a
warning and runs again at the next `workrift deps`. Bootstrap sets the Bite warm step to
`bun run compile` and links its `.env`. Per-repository create and remove hooks
belong in Rift's own `.rift.toml` in the source.

`workrift prune` keeps pinned, in-use and recently modified workspaces and every
ancestor of a kept workspace, and archives the rest to `~/rift-archive/<date>`
for 30 days before it removes them. Pin a workspace by adding its path to
`~/.config/workrift/keep`. No timer runs it.

All workspaces use the local cache at `/workspaces/.cache/turbo`.
`TURBO_CACHE=local:rw` disables remote cache reads and writes. Turbo 2.10 and later
evicts the oldest entries at the start of a run once the cache passes
`TURBO_CACHE_MAX_SIZE` (2 GB). Turbo uses two
concurrent tasks by default on this workbox.

The Mosh server wrapper gives each new server a 15-minute signal timeout. The
cleanup timer sends the Mosh stale-session signal every 15 minutes. Connected
servers ignore the signal. Disconnected servers exit. The cleanup skips legacy
servers that do not have the signal timeout.
