# Workbox on btrfs

The workbox (exe.dev VM `bite-cristian`) keeps everything but the OS on btrfs,
so Rift can snapshot any checkout and nothing needs a git worktree, which is a
full copy. This is the Linux counterpart of `mac/developer-volume/`.

| Mount | File system | Holds |
| --- | --- | --- |
| `/` | ext4 on `/dev/vda` | the OS core: `/usr`, `/etc`, `/var` (minus the image), `/boot`, `/swapfile`, and the headroom |
| `/workspaces` | btrfs, top level of the loop image `/var/lib/bite-workspaces.btrfs` | warm sources and Rifts, as before |
| `/home/exedev` | btrfs subvolume `@home` of the same image | the whole home: `~/Developer`, `.cache`, `.local`, `.bun`, `.codex`, `.claude`, `go` |
| `/tmp` | btrfs subvolume `@tmp` of the same image | test caches and agent scratch |

**The root stays ext4.** Converting a mounted root in place is not safe, and an
exe.dev VM boots its own root image. Everything that grows moves off it instead.

| File | Purpose |
| --- | --- |
| `grow.sh` | After a disk resize: grows ext4 online, lowers its root reserve to 1%, grows the sparse image as far as ext4 can back it, then `btrfs filesystem resize max`. Never shrinks. |
| `migrate.sh` | `plan`, `convert` (worktrees to Rifts), `home` (copy home and `/tmp`, mount the subvolumes over them), `finish` (prune worktree entries, delete the old copies). Every phase resumes. |
| `check.sh` | Before and after: space, the image-versus-ext4 rule, mounts, fstab order and the boot order systemd derives from it, `cp --reflink=always` under `~/Developer`, worktree links, the skills link, user unit paths. |
| `worktrees.conf` | Which worktrees convert (`release`) and which stay (`hold`). |
| `test.sh` | Runs all of it in a scratch root: a loop ext4 holding a loop btrfs. Needs Linux and sudo; touches only its own scratch files and loop devices. |
| `RUNBOOK.md` | The window: what to stop, the commands, times, rollback. |

## Decisions

### `~/Developer` lives on btrfs, at its own path

The other way was to keep only the warm sources in `/workspaces` and make
`~/Developer/{work,personal}/<repo>` symlinks to them. Measured on the workbox
(2026-11-13), that breaks paths and rules:

- A warm source must stay clean on its default branch, but `~/Developer/work/bite`
  is on a feature branch (`bite-19493-l2`) and `~/Developer/personal/dotfiles` is
  Syncthing-synced with local edits.
- `dotfiles`, `okra`, `opencode` and `gent` have no warm source at all.
- A symlink changes the real path (`pwd -P`, `git rev-parse --show-toplevel`),
  and OpenCode keys sessions by directory, and Rift's registry stores real paths.
  The `~/.claude/skills` link and the user units (`%h/Developer/...`) would point
  through a link into a tree with other rules.

Moving the whole home onto `@home` keeps every path. herdr, the OpenCode service,
the systemd user units and the skills link see the same paths as before.

### The whole home and `/tmp`, not only `~/Developer`

Measured: the home is 137 GiB, of which `~/Developer` is 39 GiB; `.cache` 41,
`.local` 13, `.codex` 9.5, `.bun` 9.3, `.claude` 6.6, `go` 1.2. `/tmp` holds
52 GiB in 15,000 entries. On ext4 none of it can be cloned.

### Sizing: the image may hold every byte ext4 has free, minus the headroom

The image is sparse (`discard=async` returns freed blocks), so its size is a
promise, not an allocation. The rule `grow.sh` keeps, and `check.sh` warns about:

    image size - image allocated <= ext4 free - headroom

so btrfs can never fill the root. Once home and `/tmp` are off ext4, this makes
the image the disk minus the core minus the headroom.

Measured core (2026-11-13): `/usr` 6.0 GiB, `/var` without the image 7.7 GiB
(journal 2.1, docker 0.4), `/swapfile` 4.0, `/etc`, `/root`, `/boot`, `/opt` under
0.1: about 18 GiB.

The headroom is 40 GiB (`WB_HEADROOM_GIB`): the journal up to its 4 GiB cap,
package and kernel upgrades (about 3 GiB with the previous kernel kept), Docker
images under `/var/lib/docker` (an agent pull is 1 to 5 GiB; budget 15), crash
dumps (budget 10), and room so the image file does not fragment in a nearly
full ext4. That sums to about 32 GiB; 40 leaves a margin.

`grow.sh` also lowers ext4's root reserve from 5% to 1%. The reserve protects
root daemons from users filling the disk; the users now live on btrfs and the
headroom does that job. On an 800 GiB disk it gives back about 31 GiB, and the image ends near 720 GiB (800 less 8 reserve, 18 core, 40 headroom, and ext4 overhead).

### Worktrees become Rifts, and their commits stay local

A worktree whose repository has a warm source becomes a Rift through
`workrift create <branch>`. Its commits first move into the warm source as a
local branch (a plain `git fetch` from the worktree, which refuses to move an
existing branch backwards), so nothing is pushed. Staged, unstaged and
untracked work follows. A detached worktree gets the branch `detached/<name>`.
`converted.tsv` in `~/.local/state/workbox-btrfs/` maps each old path to its Rift.

A worktree with unpushed commits or stashes stays a worktree unless its owner
releases it in `worktrees.conf`; a `hold` keeps it in any case. A kept worktree
is copied as it is and keeps working, since its path does not change.

### One rsync, with hard links

ext4 has no reflinks to carry over. `rsync -aHAXS` keeps the hard links bun
makes from `~/.bun/install/cache` into each `node_modules`, so a kept worktree
costs on btrfs what it costs on ext4.

## Not done here

- The main checkouts in `~/Developer` are plain directories in `@home`. Rift
  needs a subvolume as a source; `rift init --here <checkout>` converts one in
  place with reflinks, cheaply. It is left to the owner because a second Rift
  root with the same origin as a `/workspaces` warm source makes `workrift`
  ask which source to use.
- `/tmp` is still emptied at boot (`D /tmp` in Ubuntu's `tmp.conf`), as it is today.
