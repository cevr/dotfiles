---
name: reclaim
description: Free disk space on a Mac. Surveys developer caches, build output, idle node_modules, simulators, worktrees, agent transcripts and the images inlined in them, then removes only what the user approves. Use when the disk is full or low, or the user asks to reclaim, free up or clean up space.
---

# Reclaim

The survey is read-only; every removal follows an answered question. `df` is the only measure of space freed: `du` counts APFS clones (worktrees, bun's `node_modules`, uv environments, code-sign clones) in full, so a removal can free far less than its listed size.

## 1. Survey

```bash
bun ~/.claude/skills/reclaim/scripts/survey.ts [--keep-since YYYY-MM-DD] [--roots ~/Developer] [--json]
```

It prints free space, then every candidate by tier with its size, idle age, the command that removes it, and `[busy: …]` when a process holds it. Defaults: build output idle 2 days, `node_modules` in projects idle 30 days, agent files older than 7 days.

Before you run it, look for anything that reads old agent transcripts, such as a model eval or a retro due soon, and pass its start date as `--keep-since`.

To see what an unexplained large folder holds, use `uvx fdu@latest <dir> --view largest`. To find stale dependency folders, use `uvx fdu@latest <dir> --kind dir --include node_modules --modified-before 30d --long`.

On btrfs, `du` counts reflinked clones in full; `sudo btrfs filesystem du -s <dir>` gives the exclusive part, which is what removal frees. Quote that figure for worktrees and Rift trash.

Deleted files that a process still holds open free their space only when that process exits. Old Claude and Codex binaries held by long-running sessions are the usual case. To total them, run `lsof +L1 | awk 'NR>1 && $7 ~ /^[0-9]+$/ {s+=$7} END {print s/2^30 " GiB"}'`. Report the total as "frees when those sessions restart".

Done when every candidate over 1 GiB has a tier and a known owner. Mark an item "unknown" when you cannot say what it is.

## 2. Ask

Show one table: item, size, idle age, tier, command, and how the item comes back. Then ask with the question tool, one question per category, about four questions per round. Mark your recommended option.

| Tier | What | Ask |
|---|---|---|
| A | Regenerable: package caches, build output, idle `node_modules`, DerivedData, old DeviceSupport, unavailable simulators, updater leftovers, old CLI versions, agent leftovers, inlined transcript images | Per category. Recommend removal. |
| B | Costly to get back: simulator runtimes, Android SDK and emulators, Docker images and volumes, local AI models | Per item. Say what it costs to get back. |
| C | User data: worktrees, renders, bundles, scratch folders that git ignores, loose folders, big personal files | Per item. Never pre-select removal. For a worktree, show its dirty and unpushed counts. |

Leave alone, and say so: source code, `.git`, uncommitted or unpushed work, anything `[busy]`, Photos, Mail, Messages, Keychains, `~/.ssh`, credential and `.env` files, and app data outside the caches listed.

## 3. Remove

For each approved category, in order:

1. Record `df -k /System/Volumes/Data`.
2. Check the precondition: no `[busy]` process, and the app is closed. If anything is busy, ask the user to quit it, or skip the item.
3. Run the command the survey printed. Use the tool's own command where there is one, and delete by path only the exact paths listed.
4. Record `df` again. The difference is what that category freed.

A folder that is a symlink target (`find ~ -maxdepth 4 -type l -lname '*<dir>*'`) is live storage moved off the main disk: empty what is safe inside it, keep the folder. A filesystem in a loop-mounted image file returns freed blocks to the host disk only after a trim: run `sudo fstrim -v <mount>` and measure the host disk after it.

Agent leftovers have their own order:

1. If the user keeps a transcript archive, push it first. After that, a pruned transcript can be restored.
2. Run `bun ~/.claude/skills/reclaim/scripts/cull-transcript-images.ts` (`--dry-run` to count first). It replaces the base64 images and documents with a note, and it empties the copy of each image that the Read tool keeps for the terminal. It skips transcripts written in the last hour.
3. Run `prune-agent-files.ts --before <date>`, first without and then with `--apply`. It deletes subagent transcripts, tool-result spills and idle scratchpads. Main session transcripts stay, so every session can still be resumed.

User data goes to the Trash, not to deletion: `mv` it into a new folder `~/.Trash/reclaim-<date>/`, keeping its path relative to `~`. Emptying the Trash is a separate question.

## 4. Report

End with a table: each category removed, the GiB it freed (from the `df` difference), and free space before and after. Then list what you left and why. Also list what will be slower on its next run: installs, the first build, and the first gate after a cleared turbo cache.

Sources: the process follows [storage-rescue](https://github.com/Da7-Tech/storage-rescue) (MIT). [fdu](https://github.com/jlevy/fdu) is the drill-down tool.
