# reclaim

A Claude Code skill that frees disk space on a Mac. It surveys developer caches, build output, idle `node_modules`, simulators, worktrees and agent transcripts, read-only, then removes only what you approve, and measures each step with `df`.

Install (needs [Bun](https://bun.sh)):

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/cevr/dotfiles /tmp/reclaim-src
git -C /tmp/reclaim-src sparse-checkout set skills/reclaim
cp -R /tmp/reclaim-src/skills/reclaim ~/.claude/skills/reclaim
```

Then ask Claude Code to "reclaim disk space", or run `/reclaim`. The survey alone: `bun ~/.claude/skills/reclaim/scripts/survey.ts` (`--roots` for code folders other than `~/Developer`).

To keep transcripts small every week, schedule `bun ~/.claude/skills/reclaim/scripts/cull-transcript-images.ts`. It replaces images inlined in Claude Code and Codex transcripts with a short note.
