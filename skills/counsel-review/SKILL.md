---
name: counsel-review
description: Get an independent review of a change from the other model family through Counsel, using the code-review criteria, and validate every claim against the source. Use for "counsel review", a second-model or cross-model review, an adversarial or final review before merge or release, a stack checkpoint, an API design gate, or a test audit the other model should challenge. Read-only.
---

# Counsel Review

The other model family reviews the change against the same criteria as `code-review`. You ground the packet first and validate every claim after. Read-only: edit nothing during the review.

A PR someone else asked you to review runs `code-review`'s Requested review instead, in this session. A **direct reviewer** (a prompt that says *Review directly*: you are the other family) skips §1 and §2: it does the discovery itself by `code-review` Phases 2–3, on the packet it was given, then applies §3 to §5.

Read `../code-review/SKILL.md` and `../counsel/SKILL.md` first. The criteria live in `../code-review/references/review-contract.md` and `../code-review/references/test-audit.md`.

Send the packet (§2) the first way that works:

1. **The codex mod** (Claude Code, when `mcp__codex__start` is listed). One Codex thread per checkpoint: round one starts it, and rounds two and three go to the same thread with `mcp__codex__send`, so it keeps what it read. The answer arrives as a message when the turn ends: set no timer and do not poll.
2. **`okra counsel`** (from Codex, or when the mod's tools are missing). Run `command -v okra` first.
3. **The other family's CLI directly.** From Claude: `codex exec -s read-only -o "$out" - < "$prompt_path"`. From Codex: `claude -p --permission-mode plan < "$prompt_path" > "$out"`. The review stays cross-model.
4. **A fresh subagent** with no context from this session, given only the packet and told to run `code-review`. Label the report a same-family review.

Say which path ran in the report.

## 1. Ground the packet

For an explicit second opinion (the user asked for one, or a final gate before merge or release), run `code-review` Phases 1–3 (scope and mode, context, your review) in report outcome first: Counsel then challenges a grounded candidate. Otherwise (an orchestrate reviewer through Counsel, a stack checkpoint), ground only the scope, the contract and the diff, send the packet without finding candidates (a `design` packet still carries its candidate and the rejected alternatives), and spend your own reading on validation (§3).

## 2. Send the packet

Include every applicable item:

- Repo path, exact base and head revisions, the diff or changed files.
- The user request or ticket contract, acceptance checks, non-goals, product and compatibility invariants.
- Relevant source paths and cached dependency paths.
- Full paths of `review-contract.md`, and `test-audit.md` when tests are in scope.
- Your candidate findings with evidence; for `design`, the candidate and rejected alternatives.
- Test results, runtime evidence, and resource limits.
- The owner of each change.
- Rounds two and three: accepted findings, repairs, final diff, new proof.

Tell it: the review is read-only; attack each candidate and hunt for missed blockers; cite full paths and line numbers; say "no blocker" when there is none.

Invoke each path as [`counsel`](../counsel/SKILL.md) says, at its deep setting (`effort: "max"` through the mod, `--deep` through `okra counsel`), with the description `counsel-review <checkpoint> r<N>`. Set no short time limit.

## 3. Validate

Open every cited file and follow the control flow. Reject a claim the source does not support. Each accepted finding passes the review contract's finding test.

## 4. Rounds

At most three per checkpoint (a branch, a PR, or one stack entry).

- Round one reviews the full packet.
- If the user asked for fixes, end the read-only review, apply accepted repairs (`code-review` Phases 5–6), then send the next round: accepted findings, repairs, final diff, and new proof. Mark round three as the final round.
- A `design` gate uses one round unless round one finds a concrete blocker and the user permits a fix before the gate closes.
- **Rewrite** when round three still finds a Blocker or Major: three failed repairs mean the design, not the repairs, is wrong. Stop repairing. Write the premise every repair assumed (`~/Developer/personal/dotfiles/principles/attack-the-premise.md`), rewrite the change from the base revision on a new premise, with every round's findings as data, and review the rewrite as a new checkpoint from round one.

## 5. Report

Lead with the verdict and the safety fact (`code-review` Phase 4). Then sort every claim, yours and Counsel's, into four buckets. Each item keeps its severity and names the model that raised it (`claude`, `codex`, or `both`):

- **Act on**: accepted Blockers and Major.
- **Consider**: accepted Minor and Optional.
- **Noted**: true, and needs no change in this checkpoint (pre-existing, out of scope).
- **Dismissed**: claims the source does not support, each with the reason.

Then the `Spec` section, the round count, and the Codex thread id or the Counsel output path.
