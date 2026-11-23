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
workbox-check
```

`workbox-check` (installed into `~/.local/bin` by `install-bin.sh`) runs
`bootstrap.sh --check` from the installed build's tree
(`~/.local/share/opencode-prime/current.plugins/workbox/`), the verified
commit's checks. Do not run the checkout's `bootstrap.sh --check`: the checkout
is a Syncthing copy of the Mac's base and can lag.

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
reclaim them. It raises the inotify limits to 4194304 watches and 1024
instances (`systemd/sysctl.d/90-inotify.conf`, which the Hetzner box's
`provision.sh sysctl` installs too): the Bite lab's standby keepers watch each
file, about 286,000 each. `--check` warns when a live value is below the
file's. It starts the herdr-core core and the OpenCode service at boot. It
uses `/workspaces/.cache/turbo` as a local Turbo cache.

## Pinned tools and the reserve: system-tools.sh

`system-tools.sh` (root) installs what both provisioning paths need from one
place: `bootstrap.sh` runs it here, and the Hetzner box's `provision.sh` runs
it as its `tools` and `reserve` phases. The versions, checksums and key
fingerprint are in `pins.conf` and nowhere else (`test/system-tools.test.ts`
fails when one is typed into another file). Steps, each idempotent:

| Step | What |
| --- | --- |
| `shells` | fish, ksh and mksh from the distribution |
| `qemu` | `qemu-user-static`, and the binfmt_misc entry for the other architecture (`qemu-aarch64` on amd64, for Ergo's arm64 receipts) registered now from the package's `binfmt.d` file with the F flag; `systemd-binfmt` registers the rest at boot |
| `go` | Go from go.dev for the pinned architecture only (another is refused): the tarball's sha256 is checked before it is unpacked; the tree goes to `/usr/local/go-<version>`, `/usr/local/go` is a link to it swapped by one rename, and `/usr/local/bin/go` and `gofmt` link to it. A hand-installed `/usr/local/go` directory is replaced once (two renames apart) |
| `pwsh` | PowerShell from `packages.microsoft.com/ubuntu/<release>/prod`; the downloaded key is refused unless its fingerprint is the pin (`/usr/share/keyrings/microsoft-prod.gpg`, `microsoft-prod.list`, the same paths as Microsoft's own setup package). amd64 only: Microsoft publishes no arm64 package there |
| `reserve` | the OpenCode service's memory floor (`systemd/reserve/`), then `systemctl daemon-reload`, which applies it to running units: no restart |

`system-tools.sh --check` (run by `bootstrap.sh --check`) fails, naming the
step, unless each is in place.

**The reserve.** `bite.slice` holds the way in (the Tailscale SSH service,
tailscaled, systemd-resolved) beside `user.slice`, which holds every agent. It
runs at `CPUWeight=1000` and `IOWeight=1000` against `user.slice`'s default
100, so under agent load the way in gets the CPU the moment it asks
(2026-11-22: sshd and tailscaled starved for 15 minutes); its memory floor is
unchanged (`MemoryMin` 256M, `MemoryLow` 512M, each service its own). The
OpenCode service places itself in `opencode-service-<pid>.scope` in the user
manager's `app.slice` at CPU and IO weight 1000
(`opencode/mods/update/placement.ts`); the reserve adds its memory floor,
`MemoryMin=1G` (its RSS at rest is 0.7-0.8 GB) and `MemoryLow=4G` (its
high-water mark, 4.22 GB), through a prefix drop-in systemd applies to the
transient scope, and the same floor on each parent (`user.slice`, `user-.slice`,
`user@.service`, `app.slice`), since a cgroup's floor holds only as far as its
parent's. IO weights count only where the disk weighs IO by cgroup (io.cost or
BFQ); `--check` warns when none does.

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
  file or a dependency patch in `patches/` changed since the last install. In a
  base it waits in line for the base's exclusive lock, unless a command it runs
  under (a hook of a `git switch` or merge) holds the base: then a holder that
  installs itself (a create, advance or refresh, the older workrift's too) is
  left to it, an exclusive `workrift hold` covers it, and a `hold --shared`
  gets a note to run `workrift deps` once it ends.
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
  `WORKRIFT_PURGE=0`) the workspace stays in work's trash. A commit
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
  stale record, and is refused. Both read work's records and fail closed:
  when `work --json list` (or `work --json bases`) fails, is missing, or
  answers anything but a list of records each with a name, id, path, state
  and since, remove refuses, quotes what came back, and deletes nothing.
- `workrift prune [--dry-run]` lists the workspaces idle for two days; once
  work's gc is cleared (`work_gc_safe` in the script) it removes them with
  `work gc -idle -archive`, which keeps each one's work in its base.
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
- `install-bin.sh` installs `bin/*` into `~/.local/bin` and the shell files
  into `~/.local/share/workbox/` (renamed into place), with `~/.zshenv` and
  `~/.zshrc` linking there. The fleet update runs it after each proven install
  from the installed build's tree (`~/.local/share/opencode-prime/current.plugins/workbox/`),
  so these are the verified commit's files. The live checkout
  (`~/Developer/personal/dotfiles`) is a Syncthing copy of the Mac's base,
  and no update moves it.
  - It checks every file first (`sh -n`, `dash -n`, `bash -n` or `zsh -n` by
    its first line, and a scratch `zsh -c true` that reads the new zshenv).
    If any file fails, it names it, installs nothing and exits 1, and the
    update log shows it.
  - Each file is written beside its target and renamed over it, so a command
    or shell started during an install sees the old file or the new one,
    whole.
  - A `~/.zshenv` or `~/.zshrc` that is a file of its own is never
    overwritten. The script says what to do with it and exits 1.
  - `workbox-check` fails when the shell files are not the installed build's.
- `trash` moves files to the home trash, across Btrfs subvolumes.
- `cleanup-mosh-servers` removes disconnected Mosh servers.

## Workspaces

`workrift` makes workspaces with Ergo's `work`: a warm source is a work base,
and its workspaces go to `.work/<source>/<branch>` next to it. The Rift
backend is gone. The file `~/.config/workrift/backend` is optional; when it
exists it must say `work`: any other word (`rift`, the old default) stops every
command before it does anything, with one line that says to write `work` into
the file.

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
directory: the base of a workspace (or the base itself), or the source with the same `origin` as
a normal checkout. Set `WORKRIFT_SOURCE` to choose one explicitly.

`workrift create` first fast-forwards the source to the fetched default branch
and warms it, so the snapshot holds today's tree and the branch switch rewrites
only the branch's own changes; unchanged files keep sharing blocks with the
source. A lock on the source's Git directory serializes `create` and `refresh`.
It then makes the workspace with `work new`, a copy-on-write clone with
dependencies and compiled outputs, and creates or selects the requested Git branch, and runs the
install only when the branch's lock file differs from the last install. When the
command runs from a matching stacked checkout, it also imports `.git/gh-stack`.
On a base whose workspaces are file copies, a create's clone and a remove's
delete take one turn each, one at a time per base, first come first served
across both: on the workbox's loaded Btrfs, clones and `rm -rf` side by side
took minutes where one alone took seconds. A waiter's line names who is ahead
and for what (`clone <name>` or `delete <name>`); a holder that dies frees its
turn. The fetch, install and warm of a create, and a remove's checks, run
beside each other as before. A base that is a Btrfs subvolume (its workspaces
are snapshots) takes no turn.
`init`, `create`, `refresh` and `deps` run themselves at nice 10, and in the
idle I/O class (`ionice -c3`) where `ionice` is, so their clones, fetches,
checkouts and installs yield to the OpenCode service.
Run `gh stack checkout <PR>` in the workspace when imported metadata needs a refresh.

A branch change inside a workspace can also change the lock file. For a
repository with `lefthook.yml`, `workrift` writes an untracked
`lefthook-local.yml` in the source that runs `workrift deps` after checkout,
merge and rewrite. `.git/info/exclude` hides the file, and the copy carries
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
warning and runs again at the next `workrift deps`. `workrift init` sets a base's
host settings from the table in workrift's `base_settings` (for Bite: the warm step
`bun run compile` and the `.env` link); `workrift settings` sets them on a base made
before, as bootstrap does, and keeps a value already set to something else. With no
warm step and no warmed tree, `refresh` and `create` say its workspaces start cold.
Per-repository install and hook commands belong in the base's `work.toml`.

`workrift prune` keeps pinned, in-use and recently modified workspaces and every
ancestor of a kept workspace, and lists the rest. A base that holds a pinned path
is left out whole. Pin a workspace by adding its path to
`~/.config/workrift/keep`. No timer runs it.

All workspaces share the local cache at `/workspaces/.cache/turbo`. When the base
checkout's `/workspaces/bite/Dockerfile` carries an `ENV TURBO_TOKEN` line (or the
environment already holds `TURBO_TOKEN`), `zshenv` exports that token and
`TURBO_CACHE=local:rw,remote:rw`, so turbo also reads and writes the Bite repo's remote
cache that its `turbo.jsonc` names. That holds only in a shell that starts in the Bite
tree: `/workspaces/bite` and its workspaces under `/workspaces/.work/bite` (or the older
`/workspaces/.rifts/bite`). Anywhere else `zshenv` unsets `TURBO_TOKEN`, an inherited one
too, so no other repository's cache server receives it. Without a token it stays `local:rw`. Turbo 2.10 and later
evicts the oldest entries at the start of a run once the cache passes
`TURBO_CACHE_MAX_SIZE` (20 GB). A process started before a change to these values
keeps the old ones until it restarts, and an old cap trims the shared store. Turbo uses two
concurrent tasks by default on this workbox.

The Mosh server wrapper gives each new server a 15-minute signal timeout. The
cleanup timer sends the Mosh stale-session signal every 15 minutes. Connected
servers ignore the signal. Disconnected servers exit. The cleanup skips legacy
servers that do not have the signal timeout.
