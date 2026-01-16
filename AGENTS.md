# AGENTS.md

Cristian owns this. Start: say hi + 1 motivating line.
Work style: telegraph; noun-phrases ok; drop grammar; min tokens.

## Agent Protocol
- Contact: Cristian (@cevr, seeve.c@gmail.com)
- Workspace: `~/Developer`. Personal: `~/Developer/personal`. Work: `~/Developer/work`.
- Dotfiles: `~/Developer/personal/dotfiles`.
- Skills: `~/.claude/skills` (symlinked from dotfiles/skills).
- Editor: `code <path>`.
- Guardrails: `trash` aliased to `rm`; use for deletes.
- Commits: Conventional Commits (`feat|fix|refactor|build|ci|chore|docs|style|perf|test`).
- PRs: use `gh pr view/diff` (no URLs).
- CI: `gh run list/view` (rerun/fix til green).
- Prefer end-to-end verify; if blocked, say what's missing.
- New deps: quick health check (recent releases/commits, adoption).

Style: telegraph. Drop filler/grammar. Min tokens (global AGENTS + replies).

## Important Locations
- Personal projects: `~/Developer/personal`
- Work projects: `~/Developer/work` (bite, custom-css, pinata)
- Dotfiles: `~/Developer/personal/dotfiles`
- Claude skills: `~/.claude/skills`

## Skills
- Linear: use `linear` skill for Linear MCP workflow.
- Effect: use `effect` skill for Effect TypeScript patterns.
- `code-style` skill: refer often.
- Repo explorer: use `repo-explorer` skill to explore GitHub repos, npm packages, crates, etc.

## Git
- Safe by default: `git status/diff/log`. Push only when user asks.
- Prefer SSH remotes.
- Destructive ops forbidden unless explicit (`reset --hard`, `clean`, `restore`, `rm`, …).
- No amend unless asked.
- Multi-agent: check `git status/diff` before edits; ship small commits.
- Don't delete/rename unexpected stuff; stop + ask.

## Build / Test
- Package manager: bun preferred; pnpm fallback for legacy.
- Before handoff: run full gate (lint/typecheck/tests).
- CI red: `gh run list/view`, rerun, fix, push, repeat til green.

## Tools

### gh
- GitHub CLI for PRs/CI/releases. Given issue/PR URL: use `gh`, not web search.
- Examples: `gh issue view <url> --comments`, `gh pr view <url> --comments --files`.

## Critical Thinking
- Fix root cause (not band-aid).
- Unsure: read more code; if still stuck, ask w/ short options.
- Unrecognized changes: assume other agent; keep going; focus your changes. If it causes issues, stop + ask user.
