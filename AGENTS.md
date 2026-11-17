# AGENTS.md

## Pacing

- Default to `~/Developer/personal/dotfiles/principles/never-block-on-the-human.md` and `~/Developer/personal/dotfiles/principles/redesign-from-first-principles.md`. Read principles, don't ask which to apply.
- Pragmatism is NOT the default. Prefer structurally correct over fast move-in-place; the user invests hours for correctness.
- Reserve checkpoints for genuine ambiguity (rare) or irreversible/external actions.
- High-blast-radius work (20+ files across subsystems): split into 3-5 reviewable sub-commits, each compiling + passing gate. Don't ask for approval on strategy or naming.
- Mechanical repetitive work (propagating an established pattern across many files): delegate to a `worker` agent. Prompt must include the transformation rules, 1-2 worked examples, the validation command, and "stop and report if a file doesn't fit."

## Environment

- Contact: Cristian (@cevr, seeve.c@gmail.com)
- Workspace: `~/Developer` — `personal/`, `work/`. Dotfiles: `~/Developer/personal/dotfiles`. Skills: `~/.claude/skills` (symlinked from dotfiles/skills).
- Deletes: `rm` deletes for good; use it for build output, caches, scratch and generated files. `trash` (macOS Trash) is for the owner's data that might be wanted back. The guard hook refuses `rm -rf` on home, root or a repository root, `git reset --hard`, and a forced wide `git clean`.
- Devbox: the exe devbox `bite-cristian` IS the Bite workbox. Herdr machine `Workbox` (session `bite`) = SSH alias `bite-workbox` (Tailscale, port 2222) = host `bite-cristian`. Use `herdr --machine Workbox …`; never add another herdr machine for it.
- Principles: `~/Developer/personal/dotfiles/principles/` — read before architectural decisions or code review.
- Issue tracker: personal repos → GitHub Issues via `gh`; `~/Developer/work` (Bite) → Linear via the `linear` skill.
- Models: Fable plans, Opus first for the rest. The planner runs on the newest Claude Fable at medium, on Opus when the pool holds Fable; every other role, the verifier too, runs on the newest Claude Opus; never a pinned version, never Sonnet. Codex is the fallback for planners and verifiers only, used only when Opus is held: newest sol at `high` (a verifier at `medium`). Codex never implements: an implementor waits for Opus. A code-review second review runs on the other family (sol for an Opus reviewer, Opus for a Codex one) as an extra reader, not a role swap.

## Conventions

- Conventional Commits. Push after the gate is green; pushing is reversible, so it needs no ask. Deploys, publishes and force-pushes to shared branches still ask.
- Bun preferred; pnpm fallback for legacy.
- Run full gate (lint/typecheck/tests) between logical units and before handoff. CI red: fix til green.
- New deps: quick health check (recent releases, adoption).
- Bite PRs: assign and request review from `andrewgoupil`, `antwandaher` and `narminmolina` unless told otherwise.
- "Undo" reverts only your own last edit to that file. Uncommitted work stays.
- Orchestration freeze: Until 2026-11-29, no new orchestration machinery: no new plugin state, rule, hook, tool action, script or model in `opencode/mods/orchestrate`, `opencode/cmd/orchestrate`, `opencode/mods/rift` or `skills/orchestrate`; only deletions, simplifications and bug fixes. A needed rule becomes a line in the skill.

## Isolated workspaces

- Work happens in a workspace made from the repository's base, never in a Git worktree: a worktree is a full copy, a workspace a copy-on-write one (Ergo's `work`). The folder you start in does not decide this: a checkout on a file system that cannot clone (the workbox's ext4 `~/Developer`) still has its base on one that can (`/workspaces`). The guard refuses `git worktree add` wherever a base serves the checkout; `git worktree list`, `remove` and `prune` still run, to clean up old worktrees.
- In OpenCode, use the `work` tool (`create`, `list`, `remove`, `land`, and on the workbox its `workrift` actions): it runs the commands below for you, `remove` refuses a workspace with unsaved work, and `land` merges the workspaces it is given onto the default branch by their receipts and one merge check (`rift.mergeCheck`; else the repo's `rift.gate`), pushes and removes them. A run's root uses the `orchestrate` tool's `lane` and `land` instead of `work`'s `create` and `land`. The tool still answers to `rift` as an alias until 2026-12-06, when the alias and `workrift`'s name are due to change.
- Keep one clean base for each repository.
- Do not make feature changes in a base.
- On the Mac outside OpenCode, run `work new <name>` in the base (`-branch <branch>` names another branch than `<name>`): it keeps installed packages and generated output. Remove it with `work rm <name>` when its isolated work is complete.
- Workspaces live in `.work/<repo>/` beside the base; older ones, made by Rift, sit under `.rifts/<repo>/` until they land.
- Run the package install only when the lock file changes.
- On the workbox, use `workrift create <branch>` and `workrift remove`. Run them inside the repository; `workrift` finds its base.
- Run `workrift create` from the old checkout to import its `gh stack` metadata.
- `workrift create` fast-forwards and warms the base before it snapshots it. Refresh a base by hand with `workrift refresh`.

## Visual progress

- At the start of a long task, run `curl -sf -m 2 http://localhost:8228 >/dev/null`. Exit 0: use Sideshow and follow the rules below. Any other exit: skip this section for the whole task.
- Run `sideshow agent-howto` before the first Sideshow post.
- Publish a post after each useful milestone.
- Use one Sideshow session for one agent conversation.
- Check for user feedback after each post.
- Do not publish secrets or private environment values.

## Task Endings

- Before ending a turn, do the next actions that are reversible and in scope, then report them as done. Don't hand the user a list of things you could do.
- Each claim in the report carries its evidence or a label: measured, inferred, or guess.
- Ask the user for what is genuinely theirs with an async question (`ask_user_async` in OpenCode), not a "What I need from you" section in the reply: a preference, an irreversible or external action, access you lack. Ask it the moment you know it, give each question the assumption you work on meanwhile, and keep going. One concrete action per question: exactly what to do, where (which site, app, file or person), and what to send back. Write "Log into CommBank NetBank and export Jan to Jun 2026 as CSV, then drop it in `inbox/`", not "I need the bank data".
- Don't ask again what is already open; withdraw a question once it is answered some other way or no longer matters. Put the quickest or most blocking question first.
- After a big task, ask about the automations worth setting up.
- In OpenCode, never write a "What I need from you" section, not even a short one: call `ask_user_async`. Subagents may call `ask_user_async` too: the question surfaces in the orchestrator's (root) session, where the owner answers it, and the answer comes back to the subagent.
- Only where no async question tool exists (Claude Code, Codex) end the turn with a short numbered **"What I need from you"** section instead, held to the same rules.
- End a turn with **"In the queue"**, left out when it has no items.
- **"In the queue"** lists what runs now: background agents, Codex threads, latched turns, waits and monitors, each with its state. Then list what comes next: your next steps, and dated items with their date. Mark each item as yours or another session's.
- In OpenCode, keep the `queue` tool current as items change; the end-of-turn section stays.
