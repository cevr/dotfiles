# Bite workbox

This directory defines the persistent workflow layer for the Bite workbox
(today the exe.dev VM `bite-cristian`; from December the Hetzner AX102 that
`linux/hetzner-workbox/` provisions).

## Apply

Use this command in the approved deployment, as the workbox user.

### Host identity

These commands assume a machine you trust: the check behind this document constrains the commands as written here, not your shell's startup files, the programs those command names resolve to, this checkout, or the local and remote configuration of the tools they use (ssh, git, systemd, rsync).

Replace the literal `<machine-id-from-deployment-record>` with the intended
workbox ID from the operator's deployment record opened at order time and
confirmed via the provider console.
Reading the ID from whichever machine you are logged into defeats the check.

```sh
# Pin source: workbox deployment record; see [Host identity](#host-identity).
WORKBOX_EXPECT_MACHINE_ID='<machine-id-from-deployment-record>' ~/Developer/personal/dotfiles/workbox/bootstrap.sh
```

Run this command to verify the installed state:

```sh
# No pin needed: read-only health check.
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
terminals and every agent, under a 73% aggregate workload budget without swap. It caps
`/dev/shm` at 8 GB because no process owns its files and the kernel cannot
reclaim them. It raises the inotify limits to 4194304 watches and 1024
instances (`systemd/sysctl.d/90-inotify.conf`, which the Hetzner box's
`provision.sh sysctl` installs too): the Bite lab's standby keepers watch each
file, about 286,000 each. `--check` warns when a live value is below the
file's. It starts the herdr-core core at boot. The legacy box still uses the
OpenCode user service; the new box uses the protected system unit after the
client integration is active. It
uses `/workspaces/.cache/turbo` as a local Turbo cache.

## Pinned tools and the reserve: system-tools.sh

`system-tools.sh` (root) installs what both provisioning paths need from one
place: `bootstrap.sh` runs it here, and the Hetzner box's `provision.sh` runs
it as its `tools` and `reserve` phases. The versions, checksums and key
fingerprint are in `pins.conf` and nowhere else (`test/system-tools.test.ts`
fails when one is typed into another file). Steps, each idempotent:

| Step | What |
| --- | --- |
| `btrfs` | btrfs-progs with simple quotas (6.7 or newer): where the distribution's is older (Ubuntu 24.04 has 6.6.3), the pinned package, checked by sha256 before it is installed |
| `shells` | fish, ksh and mksh from the distribution |
| `qemu` | `qemu-user-static`, and the binfmt_misc entry for the other architecture (`qemu-aarch64` on amd64, for Ergo's arm64 receipts) registered now from the package's `binfmt.d` file with the F flag; `systemd-binfmt` registers the rest at boot |
| `go` | Go from go.dev for the pinned architecture only (another is refused): the tarball's sha256 is checked before it is unpacked; the tree goes to `/usr/local/go-<version>`, `/usr/local/go` is a link to it swapped by one rename, and `/usr/local/bin/go` and `gofmt` link to it. A hand-installed `/usr/local/go` directory is replaced once (two renames apart) |
| `pwsh` | PowerShell from `packages.microsoft.com/ubuntu/<release>/prod`; the downloaded key is refused unless its fingerprint is the pin (`/usr/share/keyrings/microsoft-prod.gpg`, `microsoft-prod.list`, the same paths as Microsoft's own setup package). amd64 only: Microsoft publishes no arm64 package there |
| `reserve` | the separate protected server slice and system unit (`systemd/reserve/`), then `systemctl daemon-reload`; client integration activates this service |
| `slices` | the run families from `slices.conf`: `/etc/systemd/user/<family>.slice` for each user line, a drop-in for each system line, and cpu, io and memory delegated to the user manager (`systemd/slices/`); then `daemon-reload`, no restart. A CPU cap written as a share of the threads (`CPUQuota=62.5%threads`) becomes a percentage of this host's `nproc` (16 threads: 1000%). A running user manager takes the io delegation at its next start (a boot), not at a reload. A run joins a family with `systemd-run --user --scope --slice=<family>.slice -- <command>` (linux/hetzner-workbox/README.md, Layout) |
| `tmp` | `/tmp`'s rules (`systemd/tmp/tmpfiles.d/tmp.conf`: emptied at boot, aged at 7 days, `/tmp/opencode` at 14, the families' `/tmp/ergo`, `/tmp/bite-work`, `/tmp/personal` at 7 on lines of their own, `/tmp/vperf2` never aged on the exe box) and the daily clean through `workbox-tmp-clean`, which preserves run trees with holders |
| `diskfree` | `workbox-disk-free.timer`: every minute, `/run/workbox/disk-free` gets the btrfs's free space from `btrfs filesystem usage` (not df), for the work tool and the host arbiter to read; it enforces nothing |

Read-only `system-tools.sh --check` (run by `bootstrap.sh --check`) needs no
pin and fails, naming the
step, unless each is in place.

**Guarantee: containment is for accidents, not work done through `sudo` or
deliberate use of root.** `bite.slice` holds the way in (the Tailscale SSH service,
tailscaled, systemd-resolved) beside `user.slice`, which holds every agent. It
runs at `CPUWeight=1000` against `user.slice`'s default
100, so under agent load the way in gets the CPU the moment it asks
(2026-11-22: sshd and tailscaled starved for 15 minutes); its memory floor is
unchanged (`MemoryMin` 256M, `MemoryLow` 512M, each service its own). The
protected `workbox-opencode@<user>.service` has a 9% maximum and a 2%/7%
memory floor in `workboxprotected.slice`, outside the 73% workload cap.
SSH sessions, the user manager and unclassified user units all inherit the
workload cap; cron, at and default Docker containers bill their jobs child.
Systemd restarts the protected unit after an OOM unless it is explicitly stopped.
The run families track I/O with `IOAccounting`, but do not set I/O
weights (linux/hetzner-workbox/README.md, Run families, says why). `--check`
warns when a user's own `~/.config/systemd/user/<family>.slice` shadows an
installed one.

Use `workbox-run bite-work -- bun test` (or another family or `default`) for
bounded tests. Each call opens a new user scope with its own hard cap
(`--memory-max SIZE`, default 12 GiB), no swap and whole-run OOM handling.
See the [host contract](../linux/hetzner-workbox/README.md#layout-scratch-caches-run-families-free-space)
for limits and exit codes. The default OpenCode shell adapter is separate.

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

`workbox-pressure.timer` samples host CPU, memory and I/O pressure and logs
the largest five user processes by RSS every minute. Read the samples with
`journalctl --user -u workbox-pressure.service`.

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
- `workrift subvolume [--back | --drop-old [--lose N:DIGEST]] [--apply]` switches the warm source
  between a plain folder and a btrfs subvolume (see "A base that is a
  subvolume" below). Without `--apply` it changes nothing: it prints its
  preflight and every step with absolute paths.
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
`workbox-rift-storage --fstab` does only that. Both require the deployment
pin; read-only `--check` needs no pin and fails while one is left.
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

### A base that is a subvolume

When a base is the root of a btrfs subvolume, `work new` makes each workspace
as one writable snapshot and `work rm` deletes it with one
`btrfs subvolume delete` (Ergo's btrfs cloner). When the base is a plain
folder, work copies it file by file. `workrift init` and
`workbox-rift-storage --apply` make new bases as subvolumes on btrfs.
`workrift check` warns about a base on btrfs that is a plain folder.
A create deletes from its new workspace, and names, any Git lock or
temporary pack that the copy carried from the base, where a Git process
outside the line held it at that instant. It never touches the base.

`workrift subvolume --apply` converts a live base and leaves every workspace
as it is: work removes each record by the cloner that made it. The command
runs these steps:

1. It refuses to start in any of these cases:
   - a removal of the base runs;
   - an older workrift (one that takes no place in the base's line) runs;
   - a process outside the line works in the base;
   - a Git lock file is present;
   - quotas are on;
   - the mount lacks `user_subvol_rm_allowed`;
   - free space or metadata slack is below the gates
     (`WORKRIFT_SUBVOLUME_MIN_*`).

   A removal of another base also refuses it, because the copy shares the
   file system's metadata with that removal. `--beside-other-removals` lets
   the command run beside such removals, and its output says how many it saw.

   It finds processes in the base by their open files, working folders,
   roots and executables under /proc, each thread's working folder and root
   (a thread that unshared its file system info has its own), and each
   memory map (a file mapped and its fd closed): one `find` under `LC_ALL=C`,
   with `grep` over the maps batched through it. Each process the walk meets
   falls into one of three kinds, read from the errno text of each message
   find or grep gives for an entry of it:
   - ended during the walk: its /proc folder is gone, the one meaning of
     ended. It holds nothing, and the preflight line counts it. An fd link
     gone while the process lives is a file it closed, and a thread gone
     with its task folder ended, so those are nothing either;
   - unread (an entry refused: permission). This is another user's process
     (root's, on the workbox), or this user's own when it holds privileges
     this user lacks (the workbox's user systemd: its fd folder lists, its
     links do not read), or one whose stat does not read while its folder
     is there. Each stat is read whole: a command name may hold newlines and
     `) `;
   - read: judged by its links and maps.

   A /proc mounted with `hidepid=invisible` (or 2, 4, `ptraceable`) does not
   list other users' processes at all: the whole walk is then unread, so it
   refuses, or runs beside them with `--beside-unreadable` (and the drop
   rule for that flag applies).

   Any other message, or no /proc, is a failed walk: the command refuses and
   says find's line. `workrift processes <folder>` runs the same walk read
   only and prints the count of each kind (the probe before a rehearsal).

   An unread process may or may not be in the base. The command names such
   processes by count and uid and never takes them for none:
   - where `sudo -n` works, it reads exactly those processes again, read
     only, all of them in one call (`sudo -n find /proc/<pid>/fd
     /proc/<pid>/cwd … -lname <base>`, with their roots, executables, maps
     and threads). A process whose start time changed since the walk (its
     pid reused) is a new process that lives: it is judged as itself, and
     named as such when it is in the base. The step log says the command line,
     and says it again only when the set changes. It refuses if one is in
     the base;
   - otherwise it refuses, unless `--beside-unreadable` is given: then it runs
     beside them, and the step log says how many and whose. Where sudoers
     allows `sudo -n true` but refuses that `find`, the refusal says so, and
     `--beside-unreadable` is the only way on without a change to sudoers.

   While the switch waits for processes to leave the old tree, it looks
   after 1 s, then 2 s, then every 4 s.

   Kernel threads and zombies hold no files and never count. Any other
   failure of the walk is a refusal of its own. The same three answers hold
   after the exchange (an unknown process leaves the switch unfinished) and
   for `--drop-old`.
2. It takes the base's exclusive lock and its clone turn in line. Creates
   wait behind it and none fails. It waits at most
   `WORKRIFT_SUBVOLUME_TURN_WAIT` seconds (default 1800) and otherwise exits
   1 with nothing changed.
3. It reflink-copies the base into `<parent>/.subvolume-move/<name>.new`
   and refreshes the index of the copy. It then checks the copy against the
   base:
   - HEAD, refs, status (untracked files too), lock files and Git's own
     files (config, info, hooks) are equal;
   - the object store's listing is the same at the copy's start, at its end
     and in the copy;
   - every ref tip and its tree are present;
   - no Git lock or temporary pack is in the copy.

   Git processes outside workrift's line (a plain `git fetch` and the auto gc
   it starts) can change the base while the copy walks it. If any check fails,
   the command copies `.git` again, at most twice, and otherwise rolls back.
   The `cp` runs as a child whose pid the state file records: when only the
   command's shell is killed, the `cp` runs on, and the next `--apply` waits
   for it to end (at most `WORKRIFT_SUBVOLUME_WAIT` seconds, else it names
   the pid and changes nothing) before it deletes that copy.
4. It swaps the copy and the base in one `renameat2(RENAME_EXCHANGE)` and
   parks the old tree at `<name>.old`, recorded by its identity.
5. It waits for processes to leave the old tree, carries in the refs the old
   tree gained (each with its objects, by a fetch from the old tree), runs
   `work refresh`, and makes and removes a smoke snapshot workspace.

The exchange is the commit point. A failure before it rolls back: the base
never moved, and the command deletes only its copy, which was never the
base. From the exchange on, the new tree has been the live base, and anything
may have been written into it, so nothing rolls it back. A failure after the
exchange exits 1 with "not rolled back": the new tree stays the base, the
tree it was stays at `<name>.old` under its record, and a process that stays
in the old tree past the wait leaves the switch unfinished (the next `--apply`
carries what it wrote once it left), as does a carry that could not read a
tree's refs or move one of them (a Git that failed: it says what it could not
do, and a read that fails never counts as a tree with no refs). Every stop
says three things: what failed (the command, its status and the step), the
state both trees are in (`workrift subvolume: state: …`: the base, the copy,
the kept tree and the recorded phase), and the exact command that goes on
(`workrift subvolume: next: …`: the rerun, `--back` or `--drop-old`). Every
read the switch decides on returns its status: a command that failed is never
read as an empty answer (no process, no lock, no refs), and one that cannot be
told is a refusal. If the command is cut (kill -9 too), the
next `--apply` deletes the copy of a switch cut before its exchange and starts
again, or finishes one cut after it, working from its state file in the
base's `.workrift/subvolume/`. Every output says what it deleted, from what it
did.

After each switch, and before `--drop-old` deletes it, the output lists what
the base lacks of the tree kept at `<name>.old`: refs (with their objects),
HEAD, Git's own files, reflog entries, and the index and worktree as
`git status` sees them. Files Git ignores are not compared. The
checked-out branch is never moved by the carry. When a ref changed on both
sides, the command keeps the other value under `refs/subvolume-move/` and
says so; a ref written into one tree after the carry is carried into the
other on the next switch only where that tree has none, and never deleted.
The carry reads each tree's refs strictly. Git skips a ref it cannot resolve
and still exits 0: a broken ref with a warning, a symbolic ref to nothing with
no message. So any message from Git fails the read, and so does a ref name in
the tree's own store (the files under `.git/refs` and `packed-refs`) that the
listing lacks. The carry then names that ref and moves nothing.

A run without `--apply` writes nothing, not even the state folder.

The tree the base was stays at `<name>.old` until
`workrift subvolume --drop-old --apply`, which deletes only the tree that the
last switch recorded there (a subvolume's id or a folder's inode). Nothing
goes to a trash. Nothing is deleted that an earlier run did not list, by
content. When the kept tree holds anything the base lacks, the drop takes two
runs. The dry run, `workrift subvolume --drop-old`, lists those items and
prints the command that deletes the tree, `--drop-old --apply --lose
N:DIGEST`. N is their count, and DIGEST is the start of the sha256 of the
listed lines. Each line names content: a ref with its commit, a Git file with
its checksum, each reflog entry, and each worktree or index line with the
object id of the file it holds. So a ref moved to another commit, a ref
swapped for another, or a file edited again gives another token, even with
as many items. The command refuses when the token is not that of the list by
then. Every refusal of a drop prints the list, and its next command is that
dry run. When the base holds all of the kept tree, `--drop-old --apply`
deletes it in one run. When part of the list does not read, no run of
workrift deletes the tree: the dry run prints the command that deletes it by
hand.

The deleting run takes the base's move ticket, renames `<name>.old` to
`<name>.dropping`, walks the processes in it again, lists again what the
base lacks of it and compares the token. Any difference renames it back,
prints the lines that were added and removed, and deletes nothing. Only the
tree set aside is deleted, never the path `<name>.old`. One window is left:
a process that enters `<name>.dropping` by that path between the walk and
the delete. Nothing of workrift's uses that path.

With `--beside-unreadable`, a process the walk could not look into may
already be inside the tree, and may write after the listing. So no run
deletes a tree beside such processes while it holds anything the base lacks:
the dry run lists it and prints no command that deletes, and the run refuses.
It names the processes and the two ways on: stop them, or run it where
`sudo -n` reads them (read only). A tree that holds nothing the base lacks
is still deleted beside them. The output then says that what they write into
it after the listing is not listed, and the delete takes it. A drop that was cut short
lists the tree again where it stands, at `.old` or `.dropping`, and its
rerun needs the token of the present list. `--back` switches to the kept
tree in the same way. With no kept tree, `--back` copies into a new folder.

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
