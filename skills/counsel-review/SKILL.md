---
name: counsel-review
description: Get an independent review of a change from the other model family through Counsel, using the code-review criteria, and validate every claim against the source. Use for "counsel review", a second-model or cross-model review, an adversarial or final review before merge or release, a stack checkpoint, an API design gate, or a test audit the other model should challenge. Read-only.
---

# Counsel Review

The other model family reviews the change against the same criteria as `code-review`. You ground the packet first and validate every claim after. Read-only: edit nothing during the review.

A PR someone else asked you to review runs `code-review`'s Requested review instead, in this session.

Read `../code-review/SKILL.md` and `../counsel/SKILL.md` first. The criteria live in `../code-review/references/review-contract.md` and `../code-review/references/test-audit.md`.

Counsel needs the `okra` CLI. Run `command -v okra` first. When it prints nothing, tell the user plainly that the cross-model review is unavailable because okra is not installed, run `code-review` in this session instead, and label the report a single-model review.

## 1. Ground the packet

Run `code-review` Phases 1–3 (scope and mode, context, your review) in report outcome. Counsel challenges a grounded candidate; it does not do discovery.

## 2. Send the packet

Include every applicable item:

- Repo path, exact base and head revisions, the diff or changed files.
- The user request or ticket contract, acceptance checks, non-goals, product and compatibility invariants.
- Relevant source paths and cached dependency paths.
- Full paths of `review-contract.md`, and `test-audit.md` when tests are in scope.
- Your candidate findings with evidence; for `design`, the candidate and rejected alternatives.
- Test results, runtime evidence, and resource limits.
- The owner of each change.
- Round two only: accepted findings, repairs, final diff, new proof.

Tell it: the review is read-only; attack each candidate and hunt for missed blockers; cite full paths and line numbers; say "no blocker" when there is none.

```bash
prompt_path="$(mktemp -t counsel-review)"
# write the packet to "$prompt_path"
okra counsel --deep -f "$prompt_path"
```

Read the output file named on stdout (`claude.md` or `codex.md`), and its `.stderr` on failure. Set no short time limit.

## 3. Validate

Open every cited file and follow the control flow. Reject a claim the source does not support. Each accepted finding passes the review contract's finding test.

## 4. Rounds

At most two per checkpoint (a branch, a PR, or one stack entry).

- Round one reviews the full packet.
- If the user asked for fixes, end the read-only review, apply accepted repairs (`code-review` Phases 5–6), then send round two: accepted findings, repairs, final diff, and new proof, marked as the final round.
- A `design` gate uses one round unless round one finds a concrete blocker and the user permits a fix before the gate closes.
- No third round unless the user changes the limit.

## 5. Report

Lead with the verdict and the safety fact (`code-review` Phase 4). Then sort every claim, yours and Counsel's, into four buckets. Each item keeps its severity and names the model that raised it (`claude`, `codex`, or `both`):

- **Act on**: accepted Blockers and Major.
- **Consider**: accepted Minor and Optional.
- **Noted**: true, and needs no change in this checkpoint (pre-existing, out of scope).
- **Dismissed**: claims the source does not support, each with the reason.

Then the `Spec` section, the round count and the Counsel output path.
