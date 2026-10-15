---
name: maintain-verification-skill
description: Keep a project's verify-<app> skill honest as the app changes; a source reader per feature, one live pass over every feature, at most one commit of proven corrections.
disable-model-invocation: true
---

# Maintain a verification skill

A feature map rots as the app changes. This pass audits one `verify-<app>` skill (made by `create-verification-skill`, or any project skill with launch and drive sections and a `features/` map) against the app as it is now. The unit of rigor is the feature: every feature file is read against source, and every feature is driven live.

## Outcome

End with exactly one:

- **clean**: every feature had source and live coverage, and nothing needs changing. No commit.
- **changed**: one commit of proven corrections to the skill.
- **blocked**: coverage could not finish, or a proven fix could not ship. Say what blocked it and what coverage did finish.

## Edit scope

Edit only the skill's own directory and the helper scripts its `SKILL.md` names. Product code is read-only for the whole pass. A behavior the map describes that the app no longer has is one of two things: drift (fix the map), or a product regression (report it with its evidence; it becomes a ledger row or a follow-up unit, never a doc edit that hides it).

## Pass

1. **Locate.** Find `.claude/skills/verify-*/` with a `features/` dir. With several, the caller names one. With none, stop and run `create-verification-skill` instead.
2. **Index.** Read `features/README.md` and list its sibling files. Fix missing, extra, duplicate and dead entries.
3. **Source wave.** Start one read-only `Explore` agent per feature file, all in one message (in batches of about 8 when there are more). Each explains, from source, how its feature works for a user, and returns:
   - a feature summary;
   - the source entry points;
   - likely drift, each with a `file:line`, or "none";
   - one live recipe.

   They never drive the app and never edit.
4. **Reconcile.** Every feature file has a returned summary. Spot-check each cited drift; do not re-prove clean claims. Read `git log` since the skill's last commit for user-facing surfaces the map lacks: a missing feature needs a concrete source path. Merge the recipes into as few app states as you can.
5. **Live pass.** Required even when the source wave found nothing. You drive, serially, by the skill's own Launch and Drive sections, and you drive every feature at least once. Hold three invariants throughout:
   - **Doctor first.** Run doctor before the first drive, and again after any failed or surprising drive. Where doctor cannot see the problem (a wedged UI on a healthy process), relaunch rather than hope.
   - **Evidence survives.** Check it, video included, at its named path after each cleanup.
   - **Nothing outlives its use.** Each failed attempt's processes, sessions and scratch roots are cleaned before the next.

   A doctor failure caused by the skill's own drift is drift: fix it within scope and retry once. A feature you cannot reach is `verified-unreachable` only with the concrete prerequisite and the route tried; a prerequisite the map omits is drift. Every harness fix is driven live again before it ships. Tear down after the last drive.
6. **Triage.**
   - A wrong or missing user-POV description is **drift**: fix it.
   - Working behavior the harness cannot drive is a **harness gap**: fix it as a `bun run` script in the repo with its invocation in `SKILL.md`, the same helpers rule as creation.
   - Broken app behavior is a **product gap**: report it, and keep it out of the commit.
7. **Ship or stop.** For **changed**: re-read every changed file, run the repo's gate (the docs guard reads the skill where the repo has one), and make one Conventional Commit, `docs(verify-<app>): …`. Commit where the repo says: on main when it commits to main (bible-tools), and in a branch and PR only when it uses PRs. Push as the repo's rules say. For **clean** or **blocked**: no commit.

Keep run notes (features covered, unreachable prerequisites, confirmed drift) in `tmp/`, uncommitted.

## Report

The outcome; features driven live as n/n; each unreachable feature with its prerequisite; the drift fixed; the product gaps with evidence paths; the commit hash, if any.
