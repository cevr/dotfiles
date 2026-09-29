# Bite workbox

This directory defines the persistent workflow layer for the Bite exe.dev VM.

## Apply

Run this command on the workbox:

```sh
~/Developer/personal/dotfiles/workbox/bootstrap.sh
```

Run this command to verify the installed state:

```sh
~/Developer/personal/dotfiles/workbox/bootstrap.sh --check
```

The base VM must already have Bun, Claude, Herdr, MongoDB, Redis, Syncthing,
Tailscale, and the Bite repository. The bootstrap installs the workbox shell,
pinned Bun tools, the Hunk Herdr plugin, Sideshow, agent settings, S3 backups,
health checks, update checks, security updates, the Tailscale SSH service, and
swap protection. It configures `systemd-resolved` with public fallback servers.
It protects Tailscale, the DNS resolver, and the Tailscale SSH service from
workload memory pressure. It also keeps the Bite Herdr server active after a VM
restart. It mounts a fixed 60 GB Btrfs workspace file system at `/workspaces`.
It uses `/workspaces/.cache/turbo` as a local Turbo cache.

Press `Ctrl+B`, then `H`, to open the current worktree in a Hunk tab.
Press `Ctrl+B`, then `S`, to send saved notes to the source agent.
These bindings replace the default focus-left and focus-down bindings.
Herdr and Hunk both use the Rose Pine theme.

## S3 backups

The backup timer writes private encrypted objects to
`s3://bite-workbox-backups-251766048541/snapshots/`.

The command uses the `bite-dev` AWS SSO profile. It uploads each snapshot,
downloads the object, checks its SHA-256 value, and then removes its temporary
local files. AWS SSO must remain valid on the workbox.

The bucket blocks public access. It enables versioning and deletes current and
noncurrent snapshot objects after 14 days.

## Commands

- `workbox-health` checks the full remote workflow. Its network checks cover the
  resolver, public DNS, public HTTPS, Tailscale MagicDNS, and daemon restarts.
- `workbox-release-valve` previews runaway Bite development workload groups.
  Use `workbox-release-valve --apply` to stop the reported groups.
- `workbox-rift-storage` creates or checks the Btrfs workspace file system.
- `workrift init <repository> [path]` clones a repository as a warm Rift source.
- `workrift create <branch>` creates a complete isolated workspace from the warm
  source. It checks out the remote branch when one exists, and otherwise starts
  a new branch from the freshly fetched remote default branch.
- `workrift refresh` updates and warms the source from its default branch.
- `workrift list` lists the source's workspaces; `workrift sources` lists sources.
- `workrift remove [--with-children] [path]` moves a workspace to the Rift trash.
  It refuses a workspace with child workspaces unless you pass `--with-children`.
- `workrift prune [--dry-run]` archives and removes workspaces idle for two days.
- `workbox-port <port>` prints the private exe.dev URL for a running HTTP server.
- `backup-state` creates and verifies an S3 state snapshot.
- `check-updates` reports Ubuntu, Bun tool, and skill updates.
- `check-skills` lists skills okra would update and skill folders nothing tracks.
  Your own skills go in `skills/.own-skills`.
- `install-bun-tools` restores the pinned Bun CLI versions.
- `install-node` installs the exact Node version from `package.json`.
- `migrate-herdr-to-systemd` moves a live Herdr session under its user service.
- `cleanup-mosh-servers` removes disconnected Mosh servers.

The release valve targets Bite test daemons, Bun and TypeScript compiler groups,
and detached Bite test workers. Apply mode uses four bounded stop passes. It
does not stop Codex, Herdr, Sideshow, SSH, Tailscale, MongoDB, Redis, Syncthing,
or system services. It returns a failure if a protected agent continues to
start new workload groups.

## Rift workspaces

The root file system stays on ext4. The workspace file system uses Btrfs inside
`/var/lib/bite-workspaces.btrfs`. Its fixed size prevents Rift data from using
all system storage. The image mounts through `/etc/fstab` at `/workspaces`.

Each repository has one clean warm source, such as `/workspaces/bite`. Do not
use a warm source for feature work. `workrift` finds the source from the current
directory: the Rift root of a workspace, or the source with the same `origin` as
a normal checkout. Set `WORKRIFT_SOURCE` to choose one explicitly.

`workrift create` uses a writable Btrfs snapshot with dependencies and compiled
outputs. It then creates or selects the requested Git branch, and runs the
install only when the branch's lock file differs from the source. When the
command runs from a matching stacked checkout, it also imports `.git/gh-stack`.
Run `gh stack checkout <PR>` in the Rift when imported metadata needs a refresh.
New workspaces go to `.rifts/<source>/<branch>` next to the source.

A source's Git config holds its settings: `workrift.main` (default branch),
`workrift.install` (default: from the lock file) and `workrift.warm` (a step
after the install on refresh). Bootstrap sets the Bite warm step to
`bun run compile` and links its `.env`. Per-repository create and remove hooks
belong in Rift's own `.rift.toml` in the source.

The `workrift-prune.timer` runs `workrift prune` each day at 03:30. It keeps
pinned, in-use and recently modified workspaces and every ancestor of a kept
workspace, and archives the rest to `~/rift-archive/<date>` for 30 days before
it removes them. Pin a workspace by adding its path to `~/.config/workrift/keep`.

All Rift workspaces use the local cache at `/workspaces/.cache/turbo`.
`TURBO_CACHE=local:rw` disables remote cache reads and writes. Turbo uses two
concurrent tasks by default on this workbox.

The Herdr service keeps running when the kernel kills a pane process for excess
memory use. It does not restart when another Herdr server already owns the
session. Systemd stops repeated unknown start failures after three attempts in
60 seconds.

The Mosh server wrapper gives each new server a 15-minute signal timeout. The
cleanup timer sends the Mosh stale-session signal every 15 minutes. Connected
servers ignore the signal. Disconnected servers exit. The cleanup skips legacy
servers that do not have the signal timeout.

Preview the Herdr migration:

```sh
migrate-herdr-to-systemd --dry-run
```

Run the migration:

```sh
migrate-herdr-to-systemd
```
