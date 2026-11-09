---
name: upstreams
description: Distill what changed in the outside skills we folded into our own (Emil Kowalski, Jakub Krehel, pstack, Matt Pocock, taste-skill, Fold, nando-skill and the rest in upstreams.json), and sync the okra-managed skills. Use for the weekly upstream review, "/upstreams", "check upstream skills", "what changed in Emil's skills", or when adding a new outside source we fold in.
---

# Upstreams

Our own skills distill outside skills. `upstreams.json` records, for each source, the repo paths we read, the skills they feed (`into`), the license, and the upstream commit we last reviewed (a hash of the content for a source with no repo). Every review moves that commit forward, whether or not anything was taken.

The script is `scripts/upstreams.ts` (run with `bun`). A weekly launchd job (`mac/launchd/com.cvr.upstreams-scan.plist`, Monday 09:00) runs `scan --notify`: it writes `~/.cache/upstreams/digest.md` and posts a notification when something moved. Nothing is folded without a session.

## 1. Scan

```bash
bun ~/.claude/skills/upstreams/scripts/upstreams.ts scan
```

It lists each source that moved since its recorded commit, the okra-managed skills an update would change, and the managed skills with local edits. okra records a hash of each skill it writes, and `okra skills update` skips a skill whose files changed since (`modified`).

## 2. Sync the managed skills

For a `modified` skill, move the local edits into its source first (okra's own skills live in `~/Developer/personal/okra/skills`, and a skill another of our repos publishes lives in that repo; for a third-party repo, ask the owner whether to make the skill our own in `skills/.own-skills`). Then run `SKILLS_DIR=<rift>/skills okra skills update` in a dotfiles Rift and commit it as `chore(skills): sync okra skills`. Pass `--force` only to discard a local edit on purpose. Done when the scan shows no outdated and no modified skill.

## 3. Review each moved source

Read the change, not the summary: `upstreams.ts diff <name> --stat`, then `diff <name>` for the files that matter. Read the target skills' files the change touches. Sort each change into one:

- **Take**: a new rule or a sharper version of one we hold, true for our stack.
- **Already have**: we hold it already, or we moved past it.
- **Reject**: it conflicts with our principles or skills; one line on why.
- **Out of scope**: a feature we did not fold (a new skill of theirs we do not use).

Done when every commit in the scan has a sort. A new upstream skill that deserves its own place is a question for the owner, not a fold.

## 4. Fold what you take

- Put each rule where its single source of truth already lives in our skill; extend that passage instead of adding a parallel one. Follow `writing-for-agents`.
- **License**: MIT text may be adapted with the credit line the skill already carries. A source with no license is restated in our own words, never copied.
- One commit per target skill: `docs(<skill>): fold <source>: <what changed>`, with the upstream range (`abc1234..def5678`) in the body.

## 5. Mark and ship

```bash
bun ~/.claude/skills/upstreams/scripts/upstreams.ts mark <name...>   # or --all after reviewing every source
```

Mark every reviewed source, including those where nothing was taken; commit `upstreams.json` with the folds, fast-forward main and push. Done when a rescan shows no moved source.

Report per source: taken (with the commit), already have, rejected (why), out of scope.

## Adding a source

When we fold a new outside skill, add an entry to `upstreams.json` (`name`, `repo`, `paths` as git pathspecs, `into`, `license`) in the same commit as the fold, then `mark <name>` to record the head you read. For an older fold, `mark <name> --before <fold commit time>` records the last upstream commit before it.

A source with no repo (a paste, a page) takes `url` in place of `repo` and `paths`: the raw content's address, not the HTML page around it, so a site redesign does not read as a change. `mark` stores the sha256 of that content as `folded.hash` and keeps a snapshot in `~/.cache/upstreams/url/`; `scan` reports the source as moved when the hash differs, and `diff` compares the content against that snapshot.
