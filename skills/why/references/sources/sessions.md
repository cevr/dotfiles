# Agent sessions

Most of our decisions were made in agent sessions, not in docs or chat: the owner's words, the options weighed, and the receipts of what was tried. Read them as the deliberation record.

## Where they are

- Claude Code: `~/.claude/projects/<cwd with / as ->/<session>.jsonl`, on the Mac and on the Workbox (`ssh bite-workbox`). Subagents sit under `<session>/subagents/`.
- Codex: `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`, on both hosts.
- Counsel exchanges: `/tmp/counsel/<run>/` (the other model's answers, in Markdown).
- Prompt history across projects: `devsql` (`brew install douglance/tap/devsql`), table `history`, columns `display`, `project`, `timestamp`.

## How to search

1. Find the sessions that touched the target: `rg -l '<symbol or file>' ~/.claude/projects/<project dir>`; on the Workbox the same through `ssh bite-workbox`. Sort by modification time.
2. Read the owner's own words first: `jq -r 'select(.type=="user" and (.message.content|type)=="string") | .timestamp[0:16] + " " + .message.content'`. Skip lines that start with `<` (tool and task notifications) and relayed agent messages ("From Root…", "Reply with nothing").
3. Read the compaction summaries (`This session is being continued`): each one lists the decisions and rejected options of the stretch it covers.
4. Quote the owner word for word with the session id and the time. A decision another agent reports is hearsay until a session shows the owner saying it.

## Output

For each decision found: the quote, the session id and time, the options it rejected, and whether a repo file (`NORTH_STAR.md`, `PRIOR_ART.md`, an ADR, a plan) records it. A decision found only in a session is a gap to report: it belongs in the repo.
