# Runbook: move the workbox onto btrfs

Window: Saturday after sunset (21:25Z), the same as the Mac's. Run each step
from a plain `ssh bite-workbox` shell, not from a herdr pane or mosh: step 5
ends every session of `exedev`. Times are guesses from the sizes measured on
2026-11-13 (home 137 GiB, `/tmp` 52 GiB); the scripts print progress.

`d=~/Developer/personal/dotfiles/linux/workbox-btrfs`

## Before the window

1. Grow the disk (owner, on the Mac): `ssh exe.dev resize bite-cristian --disk=800GB`.
2. `sudo $d/grow.sh` grows ext4 online, lowers the root reserve to 1%, and grows
   the image as far as ext4 can back it now (about 530 GiB while home and `/tmp`
   still sit on ext4). Seconds. `grow.sh --dry-run` shows the numbers first.
3. `$d/check.sh --before` records the starting point (reflinks fail under
   `~/Developer`; that is the point). `$d/migrate.sh plan` lists each worktree
   with its fate, the space, and the processes that use the home.

Ergo's worktrees (Ergo orchestrator, 2026-11-13; `worktrees.conf` holds them):

| Worktree | Fate |
| --- | --- |
| `ergo-batch-18` | held until batch 18 lands (~Saturday 19:00Z); Ergo removes it itself |
| `ergo-pinata-tool`, `ergo-pinata-tool-e7`, `bite-pinata-ergo`, `linear-ergo` | held: the owner decides. To convert one, change its `hold` to `release`. |
| the idle lanes `cw-*`, `ex3`, `fix-try`, `fix-ts`, `fu-*`, `irg3`, `irg4`, `irt0b`, `mono1`, `nopriv`, `oracle`, `own1` | released: converted, never deleted; some resume after the Sabbath |
| `ergo/tmp/orchestrate/wf10/spike-syntax/proto` | released: an old spike |
| the four `/tmp/opencode/*-base` entries | stale; `finish` prunes them |

`linear-ergo`, `okra-ergo` and `go-irspike` are full clones, not worktrees: they
are copied as they are. `effect-machine-m46` has no warm source with its origin
(the source's origin is a local mirror), so it is copied as it is too.

## The window

4. **Before hook: save the panes**, while herdr-bite and the OpenCode service
   still run, so the panes and their OpenCode sessions come back in step 7
   ([pane-restore](../../pane-restore/README.md)):

   ```sh
   bun ~/Developer/personal/dotfiles/pane-restore/main.ts save --session bite
   bun ~/Developer/personal/dotfiles/pane-restore/main.ts check
   ```

   `save` writes each pane's workspace, tab, folder and OpenCode session to
   `~/.local/state/pane-restore/<host>-<time>.json` (`--session bite`: herdr's
   `bite` session, not its stopped default). `check` exits 1 and names any
   saved session the service cannot open.
5. `$d/migrate.sh convert` (as `exedev`, ~1 to 3 min a lane: a snapshot, then
   the warm step) makes a Rift of each released or clean worktree. A worktree
   still in use is skipped with its process named; stop it and rerun.
   Lanes find their Rift in `~/.local/state/workbox-btrfs/converted.tsv`.
6. `sudo $d/migrate.sh home --stop` (30 to 60 min for the first copy, 5 to 10
   for the final pass). It copies itself to `/var/lib/workbox-btrfs/bin` and runs
   as the system unit `workbox-btrfs-migrate`, then:
   1. creates `@home` and `@tmp` and copies home and `/tmp` while everything runs;
   2. stops what uses the home: every system unit with an `exedev` process
      (`syncthing@exedev`, `opencode-service-*.scope`, `opencode-job-*`, the
      Ergo gate scopes), then `user@1000.service` (herdr-bite, sideshow, t3code,
      teamclaude, film-lab, sh.executor.daemon), then the `exedev` sessions
      (ssh, mosh). **Your ssh session ends here.**
   3. waits up to a minute for nothing to hold a file under the home, or an
      `exedev` file under `/tmp`; otherwise it starts the units again and stops,
      naming the processes (`journalctl -u workbox-btrfs-migrate`);
   4. copies again (only what changed), verifies the copy, appends the `@home`
      and `@tmp` lines to `/etc/fstab` after the image line (a backup goes to
      `/etc/fstab.workbox-btrfs.<time>`), moves the home to
      `/home/exedev.pre-btrfs`, and mounts both subvolumes;
   5. starts the units it stopped and runs `check.sh`.
   Follow it from a new ssh session once it ends, or with
   `sudo tail -f /var/lib/workbox-btrfs/migrate.log`.
7. **After hook: restore the panes.** Reconnect with a plain ssh shell. Paths
   are unchanged, so OpenCode finds its sessions; herdr-bite came back with the
   panes as plain shells. While the panes live in herdr (today):

   ```sh
   bun ~/Developer/personal/dotfiles/pane-restore/main.ts check
   bun ~/Developer/personal/dotfiles/pane-restore/main.ts restore --herdr
   ```

   `restore --herdr` takes the newest save and runs `opencode --session <id>`
   (`herdr --session bite pane run`) in each saved pane that is an idle shell
   (`herdr pane process-info`). It skips a pane that runs anything, or whose
   session is already open in another pane, prints `restored`, `skipped` or
   `failed` for each pane, and exits 1 if any failed. A second run types
   nothing.

   After the cutover to herdr-core (hc), the panes go to hc instead:

   ```sh
   bun ~/Developer/personal/dotfiles/pane-restore/main.ts check
   hcm apply                                  # if the tabs are not in hc yet
   bun ~/Developer/personal/dotfiles/pane-restore/main.ts restore
   herdr --session bite server stop           # from a shell outside herdr
   hcm resume
   ```

   `restore` labels each moved tab's hc terminal `migrate.resume=opencode
   --session <id>`, and `hcm resume` types it once. hcm reads herdr 0.9.5
   snapshots; the workbox runs herdr 0.9.1, so update herdr before this path.
8. `sudo $d/check.sh`: every line `ok`. Then use the box for a while.

## After the window

9. `sudo /var/lib/workbox-btrfs/bin/migrate.sh finish` runs `check.sh` and prunes
   the worktree entries of converted worktrees (and stale ones). With `--yes`
   it deletes `/home/exedev.pre-btrfs` and the old `/tmp` hidden under the
   mount, then runs `grow.sh`, which grows the image into the freed space
   (to about 720 GiB on an 800 GiB disk). Minutes.
10. At a calm time, `sudo systemctl reboot` and run `check.sh` again: it proves
    the boot order (`/workspaces`, then `/home/exedev` and `/tmp`, before
    `local-fs.target`). `check.sh` already checks the generated units without a
    reboot.

## Rollback

- Before step 6.4 nothing moved: the units start again; rerun `home` to resume.
- After it, while `/home/exedev.pre-btrfs` exists: stop the units as in 6.2, then
  `sudo umount /home/exedev /tmp`, `sudo rmdir /home/exedev`,
  `sudo mv /home/exedev.pre-btrfs /home/exedev`, restore `/etc/fstab` from its
  backup, `sudo systemctl daemon-reload`, and start the units (or reboot). The
  subvolumes stay in the image; delete them with `btrfs subvolume delete
  /workspaces/@home /workspaces/@tmp` once you are sure.
- A converted worktree stays in the old tree until `finish --yes`, and its
  commits are a branch of the warm source and of the main checkout either way.
- `grow.sh` only grows; `tune2fs -m 5 /dev/vda` restores the 5% reserve.
