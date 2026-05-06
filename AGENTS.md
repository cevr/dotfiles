# AGENTS.md

## Planning & Research

- When presenting findings, **list all file references** used to reach conclusions. Full paths.
- Especially with `okra repo`: cite specific files/lines that informed the analysis, so other agents can quickly gain context.
- Don't summarize without receipts. Show the trail.

## Pacing

- Default to `~/.brain/principles/never-block-on-the-human` and `redesign-from-first-principles`. Read principles, don't ask which to apply.
- Don't surface design choices when the principles already settle them. Asking is wasted attention.
- Pragmatism is NOT the default. When facing "structurally correct" vs "fast move-in-place rename", default to correct. The user invests hours for correctness.
- Reserve checkpoints for genuine ambiguity (rare) or irreversible/external actions (force-push, delete prod data, send messages).
- User interrupts → stop. Don't continue the previous plan.
- Run gate (typecheck/lint/test) between logical units, not just at the end.
- **High-blast-radius work → sub-commit by default.** If a "single commit" touches 20+ files across multiple subsystems (domain types + registry + N extensions + tests), break it into 3-5 reviewable sub-commits in one wave (e.g., C8.1 / C8.2 / C8.3 / C8.4). Each sub-commit must compile + pass gate. Counsel between sub-commits where warranted. This does NOT violate `migrate-callers-then-delete-legacy-apis` — sub-commits inside one planify wave are not a "parallel API for users".
- **Don't ask for green-light on sub-commit strategy or naming.** Just pick the obvious right call and proceed. If counsel surfaces a design correction (e.g., split `drivers` into `modelDrivers`/`externalDrivers`), apply it without asking. Surface only genuinely-irreversible choices.
- **The smartest model in the room designs; weaker models apply.** When you hit mechanical work — repetitive file rewrites following an already-established pattern (e.g., migrating 20 extensions to a new shape, propagating a rename through call sites) — STOP doing it yourself. Define the pattern + invariants + 1-2 worked examples, then delegate the rest to a `general-purpose` Agent (which runs on a smaller model). The current-tier model burns tokens disproportionately on work that's recipe-execution, not design.
  - Good design-tier work: shape design, error-message wording, naming/discriminator decisions, reading counsel feedback, the FIRST migration in a series (proves the pattern).
  - Good apply-tier delegation: "apply this pattern to the remaining N files, here's the recipe + 1-2 already-migrated examples + the validation command; report back with diff summary + any cases that didn't fit."
  - The delegation prompt MUST include: the exact import-rename rules, the exact transformation rules, 1-2 before/after worked examples, the validation command to run between batches, and an explicit "stop and report if a file doesn't fit the pattern" instruction.

## Agent Protocol

- Contact: Cristian (@cevr, seeve.c@gmail.com)
- Workspace: `~/Developer`. Personal: `~/Developer/personal`. Work: `~/Developer/work`.
- Dotfiles: `~/Developer/personal/dotfiles`.
- Skills: `~/.claude/skills` (symlinked from dotfiles/skills).
- Editor: `code <path>`.
- Guardrails: `trash` aliased to `rm`; use for deletes.
- Commits: Conventional Commits (`feat|fix|refactor|build|ci|chore|docs|style|perf|test`).
- PRs: use `gh pr view/diff` (no URLs). Use `/pr` skill.
- CI: `gh run list/view` (rerun/fix til green).
- Prefer end-to-end verify; if blocked, say what's missing.
- New deps: quick health check (recent releases/commits, adoption).

## Important Locations

- Personal: `~/Developer/personal`
- Work: `~/Developer/work` (bite, custom-css, pinata)
- Dotfiles: `~/Developer/personal/dotfiles`
- Skills: `~/.claude/skills`
- Brain principles: `~/.brain/principles/` — read before architectural decisions or code review.

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
- TypeScript: `tsc --noEmit` or project typecheck BEFORE considering implementation done.
- CI red: `gh run list/view`, rerun, fix, push, repeat til green.
- **When asked to fix errors: just fix them.** Don't filter by "related to my changes." If user says fix it, fix it. No preamble about scope or relevance.

## Tools

### gh

- GitHub CLI for PRs/CI/releases. Given issue/PR URL: use `gh`, not web search.
- `gh issue view <url> --comments`, `gh pr view <url> --comments --files`.

## No Bail-Outs

When things get hard, do NOT:

- Skip with `// TODO` or `// FIXME`
- Comment out working code
- Revert to a simpler approach without asking
- Cast to `any` or `as unknown as X` to silence types
- Say "this is getting complex, let's simplify" and gut the implementation
- Stub functions with `throw new Error("not implemented")`

Instead:

- Read more code. The answer is in the codebase.
- Break the problem smaller. Solve one piece, verify, next piece.
- If genuinely stuck after real effort → say what's blocking + what you've tried. Ask for direction.
- Complexity is not a reason to bail. Bad architecture is. Know the difference.

# Task Endings - "What Else Can I Handle?"

After completing any big task, end with a "Let me take more off your plate" section with three categories:

1. Next actions I can do right now — specific follow-ups I can knock out immediately
2. Automations or systems I can set up — so you never have to do it manually again
3. Things to delegate to your team — draft messages for <insert team members>

3-5 bullet points max, no fluff, goal is you walk away feeling lighter.
