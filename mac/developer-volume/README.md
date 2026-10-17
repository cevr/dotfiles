# Developer volume

`~/Developer` lives on its own APFS volume in the startup container. The volume
has no Spotlight index and no persistent FSEvents log, so build output,
`node_modules` and rifts do not feed `mds` or `fseventsd`. Live file events
still work, so watchers and dev servers behave as before. The volume shares free
space with the startup volumes (elastic, no quota): it adds no capacity.

| File | Purpose |
| --- | --- |
| `setup.sh` | Creates, mounts and checks the volume. Adapted from [elithrar's `repos-volume.sh`](https://github.com/elithrar/dotfiles/blob/main/repos-volume.sh) (MIT) for `~/Developer`. |
| `migrate.sh` | Moves an existing `~/Developer` onto the volume. Rerun it to resume. |
| `test.sh` | Runs the copy against a scratch APFS disk image. No sudo. |

## Migrate

1. Quit everything that uses `~/Developer`: editors, agent sessions, dev servers, herdr panes and shells inside it. `migrate.sh` lists what remains and stops.
2. Open a new terminal in `~` and run:

   ```sh
   ~/Developer/personal/dotfiles/mac/developer-volume/migrate.sh
   ```

   It asks for your password once (sudo), for the volume, `/etc/fstab` and `mdutil`.

The script:

1. Renames `~/Developer` to `~/Developer.pre-volume` and runs `setup.sh` on the empty `~/Developer`.
2. Copies the main checkouts with rsync 3 (hard links, ACLs, extended attributes, creation times).
3. Makes each rift (git worktrees and rift's parent links) again as an APFS clone of its copied main checkout, then lets `rsync --checksum` rewrite only the files that differ. A plain copy would turn every clone into a full copy.
4. Skips `.rifts/*/.trash`, which waits for `rift gc`.
5. Verifies the new tree against the old one and stops on any difference.
6. Moves the bun cache to `~/Developer/.cache/bun` and links `~/.bun/install/cache` to it, because bun clones packages out of its cache and clones cannot cross volumes.
7. Moves the old tree and the old bun cache to `~/.Trash`. Empty the Trash to reclaim the space.

Paths do not change, so rift's database, git worktree links and agent sessions stay valid. On a new Mac, run `setup.sh` before you clone anything.

## Trade-offs

- **The volume is unencrypted.** FileVault does not cover it. On Apple Silicon the disk is still hardware-encrypted, but the login password does not protect this volume.
- Spotlight does not search `~/Developer`. Use `rg` and `fd`.
- `nobrowse` hides the volume in the Finder sidebar. Paths still work.
- Backup tools that read the FSEvents log must do a full scan.

## Recovery

- A failed run leaves `~/Developer.pre-volume` intact. Fix the cause and rerun `migrate.sh`.
- The volume record is `/var/db/dotfiles-developer-$(id -u)/record`. The fstab entry is `UUID=<volume> ~/Developer apfs rw,nobrowse,owners`. Each change leaves a backup in `/etc/fstab.dotfiles-backup.*`.
- If the volume does not mount, `~/Developer` is an empty root-owned directory with mode 000. Do not make it writable. Run `setup.sh`.
