# Runbook: move ~/Developer onto its own volume

The window: **Saturday 2026-11-14 at sunset, 16:25 EST (21:25Z)**. Be done before the next OpenCode wake, **Monday 2026-11-16 09:00 EST** (`bun.cron.opencode-wake-wv1x5fp`). The Saturday 08:00 budget wake fires before the window.

You run every step yourself, in a plain Ghostty window outside herdr: the copy needs every agent, the OpenCode service and the editors quit, and that includes the agent sessions that wrote this. The volume is **unencrypted** (approved 2026-11-13). Agent transcripts stay on the encrypted disk: do **not** pass `--with-transcripts`.

`$D` below is `~/Developer/personal/dotfiles/mac/developer-volume`.

## Sizes on 2026-11-13 (measured, `du -skx`, logical sizes)

| What | Size | Copied? |
| --- | --- | --- |
| Main checkouts (`~/Developer` without `.rifts`) | 53.7 GiB | yes, in full |
| Live rifts (`personal/.rifts` without `.trash`) | 192 GiB | cloned from their parent; only differing files are written |
| Rift trash (`personal/.rifts/*/.trash`) | 518 GiB | no |
| `~/.bun/install/cache` | 9.3 GiB | moves to the volume |
| `~/.cache/repo` | 5.1 GiB | moves to the volume |
| Free on the Data volume | 49 GiB of 460 GiB | |

**Free space is the blocker.** The copy needs the main checkouts (54 GiB) and the caches (14 GiB) on top of the 20 GiB reserve while the old tree still exists: about **90 GiB free** (inferred from the table). Today there is 49 GiB. `migrate.sh` checks this and stops before it moves anything, but free space first (step 2).

## Steps

| # | Do | Takes |
| --- | --- | --- |
| 1 | During an ordinary work day before the window (Friday is fine), take the fseventsd baseline: `$D/check.sh --baseline`. One was taken 2026-11-13 16:31Z: 23.19 CPU s over 300 s (measured). | 5 min |
| 2 | Free space: `rift gc` in each repo with rifts (it empties `.rifts/*/.trash`), then `df -h /System/Volumes/Data`. Go on only with **90 GiB or more** free. If it is still short, empty the macOS Trash or remove build output. | 5 to 30 min (guess) |
| 3 | Quit the agents: end every Claude Code, Codex and OpenCode session, then `opencode service stop` (its kernel workers and wake jobs stop with it). | 2 min |
| 4 | `herdr server stop` (closes every herdr pane). Quit editors and dev servers. | 1 min |
| 5 | `brew services stop syncthing` (it syncs `~/Developer/personal/dotfiles`; a folder that vanishes mid-copy must not sync to the workbox). | 1 min |
| 6 | Open a new Ghostty window, `cd ~`, and boot out the launch agents that refer to `~/Developer` in their plist or script (today: the four `bun.cron.opencode-wake-*` jobs, whose scripts import `cmd/wake/backstop.ts`, and `com.cvr.cull-transcript-images`, `com.cvr.transcript-archive`, `com.cvr.upstreams-scan`): `$D/migrate.sh bootout`. It records them in `~/.local/state/developer-volume/agents-booted-out.tsv`. | 1 min |
| 7 | `$D/migrate.sh preflight` and quit whatever it still lists (a pid, its command, and what to run). It exits 0 when nothing uses `~/Developer` or the caches. | 2 min |
| 8 | `$D/migrate.sh`. It asks for your password once. It refuses while anything uses `~/Developer` or a launch agent is due within 6 h (`DEVELOPER_MIGRATE_HOURS`), and prints what to quit. Keep the Mac on power; it runs under `caffeinate`. | 1.5 to 3 h (guess; below) |
| 9 | Read the after check `migrate.sh` prints (it runs `check.sh`, step "After"). | 6 min |
| 10 | Start again: `$D/migrate.sh bootstrap`, `brew services start syncthing`, `opencode service start`, then `herdr`. Then `rift gc` once more: it drops rift's rows for the trash that stayed behind. | 3 min |
| 11 | After a day of work, empty the macOS Trash (the old tree and the old caches are there). | |

Step 8, where the time goes (guess, from the sizes above: the `du` of the main checkouts took 36 s, the `du` of the rifts with their trash 15 min):

- Finding worktrees and the space check: 5 to 20 min (a `du` of the tree).
- Copying the main checkouts, 54 GiB: 30 to 60 min.
- Cloning each rift from its parent, then `rsync --checksum` over 192 GiB, read on both sides: 30 to 60 min.
- Verifying (a dry-run rsync of the whole tree): 10 to 20 min.
- The caches, 14 GiB: 5 to 10 min.

## After

`$D/check.sh` (also run by `migrate.sh`) prints one line each:

- `volume`: `~/Developer` is its own mount.
- `no_log`: `~/Developer/.fseventsd/no_log` exists.
- `mdutil`: Spotlight indexing is disabled on it.
- `watch`: 38 `fs.watch` calls under it take under 100 ms. On 2026-11-13 on the Data volume they took 15 to 18 ms (measured, an idle fseventsd), so this check passes before the move as well; fseventsd's load is the measure that tells.
- `links`: every symlink under `~` into `~/Developer` still resolves, each one recorded before the move is still there, both caches link onto the volume, and the OpenCode config's paths exist.
- `fseventsd`: its CPU over 5 minutes, next to the baseline. Run `$D/check.sh` again on Monday during work for a fair comparison; each sample appends to `~/.local/state/developer-volume/fseventsd.tsv`.

Any `FAIL` line: see Rollback.

## Rollback

While `~/Developer.pre-volume` exists (the run stopped before it finished), nothing was removed:

1. `diskutil info ~/Developer`: if it is mounted, `sudo diskutil unmount ~/Developer`.
2. `sudo vifs` and delete the line `UUID=<volume> /Users/cvr/Developer apfs rw,nobrowse,owners 0 0` (a backup is in `/etc/fstab.dotfiles-backup.*`).
3. `~/Developer` is now an empty directory owned by root, mode 000: `sudo rmdir ~/Developer`.
4. `mv ~/Developer.pre-volume ~/Developer`.
5. If a cache moved already, `~/.bun/install/cache` or `~/.cache/repo` is a symlink: remove the link and move `~/.Trash/bun-pre-volume-<time>` or `~/.Trash/repo-pre-volume-<time>` back to its place.
6. Optional, to drop the volume: `sudo diskutil apfs deleteVolume <volume UUID>` (the UUID is the sixth line of `/var/db/dotfiles-developer-$(id -u)/record`), then remove that record directory.
7. Step 10 (start again).

After it finished, the old tree is `~/.Trash/Developer.pre-volume-<time>` until you empty the Trash: the same steps, with that path in step 4. To resume instead of rolling back, fix what stopped it and run `$D/migrate.sh` again.
