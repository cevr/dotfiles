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
swap protection. It also keeps the Bite Herdr server active after a VM restart.

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

- `workbox-health` checks the full remote workflow.
- `workbox-port <port>` prints the private exe.dev URL for a running HTTP server.
- `backup-state` creates and verifies an S3 state snapshot.
- `check-updates` reports Ubuntu and Bun tool updates.
- `install-bun-tools` restores the pinned Bun CLI versions.
