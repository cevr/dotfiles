# AGENTS.md

## Pacing

- Default to `~/Developer/personal/dotfiles/principles/never-block-on-the-human.md` and `~/Developer/personal/dotfiles/principles/redesign-from-first-principles.md`. Read principles, don't ask which to apply.
- Pragmatism is NOT the default. Prefer structurally correct over fast move-in-place; the user invests hours for correctness.
- Reserve checkpoints for genuine ambiguity (rare) or irreversible/external actions.
- High-blast-radius work (20+ files across subsystems): split into 3-5 reviewable sub-commits, each compiling + passing gate. Don't ask for approval on strategy or naming.
- Mechanical repetitive work (propagating an established pattern across many files): delegate to a `general-purpose` agent. Prompt must include the transformation rules, 1-2 worked examples, the validation command, and "stop and report if a file doesn't fit."

## Environment

- Contact: Cristian (@cevr, seeve.c@gmail.com)
- Workspace: `~/Developer` — `personal/`, `work/`. Dotfiles: `~/Developer/personal/dotfiles`. Skills: `~/.claude/skills` (symlinked from dotfiles/skills).
- Guardrail: `trash` aliased to `rm`; use for deletes.
- Devbox: the exe devbox `bite-cristian` IS the Bite workbox. Herdr machine `Workbox` (session `bite`) = SSH alias `bite-workbox` (Tailscale, port 2222) = host `bite-cristian`. Use `herdr --machine Workbox …`; never add another herdr machine for it.
- Principles: `~/Developer/personal/dotfiles/principles/` — read before architectural decisions or code review.

## Conventions

- Conventional Commits. Push after the gate is green; pushing is reversible, so it needs no ask. Deploys, publishes and force-pushes to shared branches still ask.
- Bun preferred; pnpm fallback for legacy.
- Run full gate (lint/typecheck/tests) between logical units and before handoff. CI red: fix til green.
- New deps: quick health check (recent releases, adoption).
- When stuck: read more code, break the problem smaller. If truly blocked after real effort, say what's blocking + what you tried.

## Isolated workspaces

- Use Rift instead of Git worktrees when Rift supports the file system.
- Keep one clean warm source for each repository.
- Do not make feature changes in a warm source.
- Create a Rift from the warm source with `rift create --name <name> --copy-all .` to keep installed packages and generated output. The positional argument is the source path, not a branch name. Create the branch inside the Rift afterwards.
- Run the package install only when the lock file changes.
- Remove a Rift when its isolated work is complete.
- On the workbox, use `workrift create <branch>` and `workrift remove`. Run them inside the repository; `workrift` finds its warm source.
- Run `workrift create` from the old checkout to import its `gh stack` metadata.
- Refresh a warm source with `workrift refresh`.

## Visual progress

- At the start of a long task, run `curl -sf -m 2 http://localhost:8228 >/dev/null`. Exit 0: use Sideshow and follow the rules below. Any other exit: skip this section for the whole task.
- Run `sideshow agent-howto` before the first Sideshow post.
- Publish a post after each useful milestone.
- Use one Sideshow session for one agent conversation.
- Check for user feedback after each post.
- Do not publish secrets or private environment values.

## Task Endings

- Before ending a turn, do the next actions that are reversible and in scope, then report them as done. Don't hand the user a list of things you could do.
- End every turn with a short **"What I need from you"** section, placed last. Only what is genuinely the user's goes in it: a preference, an irreversible or external action, access you lack. Number it, one concrete action per item: exactly what to do, where (which site, app, file or person), and what to send back. Write "Log into CommBank NetBank and export Jan to Jun 2026 as CSV, then drop it in `inbox/`", not "I need the bank data".
- Put the quickest or most blocking item first, and say what you'll get on with in the meantime.
- When nothing is needed, write "Nothing needed from you right now" so the user doesn't have to ask.
- After a big task, add the automations worth setting up as items too.
