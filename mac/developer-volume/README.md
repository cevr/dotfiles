# Developer volume

`~/Developer` lives on its own APFS volume in the startup container. The volume
has no Spotlight index and no persistent FSEvents log, so build output,
`node_modules` and rifts do not feed `mds` or `fseventsd`. Live file events
still work, so watchers and dev servers behave as before. The volume shares free
space with the startup volumes (elastic, no quota): it adds no capacity.

| File | Purpose |
| --- | --- |
| `setup.sh` | Creates, mounts and checks the volume. Adapted from [elithrar's `repos-volume.sh`](https://github.com/elithrar/dotfiles/blob/main/repos-volume.sh) (MIT) for `~/Developer`. |
| `migrate.sh` | Moves an existing `~/Developer` onto the volume. Rerun it to resume. `migrate.sh preflight` lists what uses `~/Developer` and what to quit, and changes nothing. |
| `check.sh` | The after check: volume, `no_log`, Spotlight, a 38-watch `fs.watch` bench, the symlinks into `~/Developer`, and fseventsd's CPU against the baseline. |
| `watch-bench.ts` | The `fs.watch` bench `check.sh` runs. |
| `test.sh` | Runs preflight, the copy, the cache move and the after check against a scratch APFS disk image. No sudo. |

## What moves, and what stays

- **`~/Developer`**, the dotfiles included (`~/Developer/personal/dotfiles`). Paths do not change, so every symlink into it (`~/.claude/skills`, `~/.config/*`), the launchd plists that run scripts from it, rift's database, git worktree links, `~/.config/opencode/opencode.json` (plugin paths, the fork checkout `prime-look` used as `OPENCODE_DEV`) and the update plugin's checkout stay valid.
- **Rifts** in `personal/.rifts` and `work/.rifts`, and git worktrees, are made again as APFS clones of their parent (a rift of a rift waits for its parent), `.git` directory included. A plain copy would turn every clone into a full copy.
- **Rift trash** (`.rifts/*/.trash`) is not copied. Its rows stay in rift's database; `rift gc` drops a row whose directory is gone (measured with rift 0.0.13).
- **Caches** move to `~/Developer/.cache` behind a symlink: `~/.bun/install/cache` (bun clones packages out of it, and clones cannot cross volumes) and `~/.cache/repo`.
- **Agent transcripts and state stay** on the FileVault volume by default: `~/.claude`, `~/.codex`, `~/.local/share/opencode`, `~/.local/state/opencode`. They hold conversation text and pasted secrets, and they write little (measured 2026-11-13, 10 minutes: 0, 2, 52 and 1 files), so moving them buys little FSEvents relief. `migrate.sh --with-transcripts` moves them to `~/Developer/.agents` behind symlinks; they are then **unencrypted at rest** like the rest of the volume.

## Migrate

1. On an ordinary work day, take the fseventsd baseline: `~/Developer/personal/dotfiles/mac/developer-volume/check.sh --baseline` (5 minutes).
2. Run `migrate.sh preflight` and quit what it lists. Today that is:
   - the OpenCode service: `opencode service stop` (its kernel workers and jobs stop with it), and every OpenCode TUI;
   - herdr: `herdr server stop` (its panes run inside `~/Developer`);
   - Syncthing, which syncs `~/Developer/personal/dotfiles`: `brew services stop syncthing`;
   - each loaded launch agent that runs from `~/Developer`: `launchctl bootout gui/$(id -u)/<label>`;
   - editors, dev servers, Claude Code and Codex sessions, and shells inside `~/Developer`.
3. Open a new terminal in `~` and run:

   ```sh
   ~/Developer/personal/dotfiles/mac/developer-volume/migrate.sh
   ```

   It asks for your password once (sudo), for the volume, `/etc/fstab` and `mdutil`.

The script:

1. Refuses while anything uses `~/Developer` or a path it moves, and prints what to quit.
2. Records the symlinks under `~` that point into `~/Developer` (`~/.local/state/developer-volume/links-before.tsv`).
3. Renames `~/Developer` to `~/Developer.pre-volume` and runs `setup.sh` on the empty `~/Developer`.
4. Copies the main checkouts with rsync 3 (hard links, ACLs, extended attributes, creation times).
5. Makes each rift and worktree again as a clone of its copied parent, then lets `rsync --checksum` rewrite only the files that differ.
6. Verifies the new tree against the old one and stops on any difference.
7. Moves the caches (and, with `--with-transcripts`, the agent state) onto the volume behind symlinks.
8. Moves the old tree and the old caches to `~/.Trash`. Empty the Trash to reclaim the space.
9. Runs `check.sh` and prints what to start again: `opencode service start`, `herdr`, `brew services start syncthing`, `launchctl bootstrap` for each agent, then `rift gc`.

On a new Mac, run `setup.sh` before you clone anything.

## After

`check.sh` is the after check; run it any time:

| Check | Passes when |
| --- | --- |
| `volume` | `~/Developer` is its own mount |
| `no_log` | `~/Developer/.fseventsd/no_log` exists |
| `mdutil` | `mdutil -s ~/Developer` says `Indexing disabled.` |
| `watch` | 38 `fs.watch` calls (one per plugin source, as the TUI makes them) take under 100 ms |
| `links` | every symlink into `~/Developer` resolves, each recorded before the move is still there, the caches link onto the volume, and the OpenCode config's paths exist |
| `fseventsd` | a report: fseventsd's CPU over 5 minutes, next to the baseline; samples append to `~/.local/state/developer-volume/fseventsd.tsv` |

## Trade-offs

- **The volume is unencrypted.** FileVault does not cover it. On Apple Silicon the disk is still hardware-encrypted, but the login password does not protect this volume. With `--with-transcripts`, agent transcripts and any secrets pasted into them are unencrypted at rest too.
- Spotlight does not search `~/Developer`. Use `rg` and `fd`.
- `nobrowse` hides the volume in the Finder sidebar. Paths still work.
- Backup tools that read the FSEvents log must do a full scan.

## Recovery

- A failed run leaves `~/Developer.pre-volume` intact. Fix the cause and rerun `migrate.sh`.
- The volume record is `/var/db/dotfiles-developer-$(id -u)/record`. The fstab entry is `UUID=<volume> ~/Developer apfs rw,nobrowse,owners`. Each change leaves a backup in `/etc/fstab.dotfiles-backup.*`.
- If the volume does not mount, `~/Developer` is an empty root-owned directory with mode 000. Do not make it writable. Run `setup.sh`.
- A moved cache or agent directory is in `~/.Trash/<name>-pre-volume-<time>` until you empty the Trash.
