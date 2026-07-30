# AGENTS.md

## Reporting

- Report only in ASD-STE100 Simplified Technical English: short sentences, active voice, one instruction per sentence, approved vocabulary.
- When presenting findings, list all file references (full paths) that informed conclusions. Don't summarize without receipts.

## Pacing

- Default to `~/.brain/principles/never-block-on-the-human` and `redesign-from-first-principles`. Read principles, don't ask which to apply.
- Pragmatism is NOT the default. Prefer structurally correct over fast move-in-place; the user invests hours for correctness.
- Reserve checkpoints for genuine ambiguity (rare) or irreversible/external actions.
- High-blast-radius work (20+ files across subsystems): split into 3-5 reviewable sub-commits, each compiling + passing gate. Don't ask for approval on strategy or naming.
- Mechanical repetitive work (propagating an established pattern across many files): delegate to a `general-purpose` agent. Prompt must include the transformation rules, 1-2 worked examples, the validation command, and "stop and report if a file doesn't fit."

## Environment

- Contact: Cristian (@cevr, seeve.c@gmail.com)
- Workspace: `~/Developer` — `personal/`, `work/`. Dotfiles: `~/Developer/personal/dotfiles`. Skills: `~/.claude/skills` (symlinked from dotfiles/skills).
- Guardrail: `trash` aliased to `rm`; use for deletes.
- Brain principles: `~/.brain/principles/` — read before architectural decisions or code review.

## Conventions

- Conventional Commits. Push only when the user asks.
- Bun preferred; pnpm fallback for legacy.
- Run full gate (lint/typecheck/tests) between logical units and before handoff. CI red: fix til green.
- New deps: quick health check (recent releases, adoption).
- When stuck: read more code, break the problem smaller. If truly blocked after real effort, say what's blocking + what you tried.

## Visual progress

- Use Sideshow for long tasks when the server is available at `http://localhost:8228`.
- Run `sideshow agent-howto` before the first Sideshow post.
- Publish a post after each useful milestone.
- Use one Sideshow session for one agent conversation.
- Check for user feedback after each post.
- Do not publish secrets or private environment values.

## Task Endings

- After a big task, end with a "Let me take more off your plate" section: 3 next actions doable now + 3 automations to set up.
