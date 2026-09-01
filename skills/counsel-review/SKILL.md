---
name: counsel-review
description: Run an independent, read-only Counsel review of a change, pull request, stack checkpoint, performance change, or API design. Use when the user asks for a Counsel review, anti-slop review, correctness review, minimality review, or final independent review before merge or release. Do not use for hands-on cleanup. Use code-review for cleanup.
---

# Counsel Review

Use the opposite local coding agent as an independent reviewer. Check the review against the source before you accept a finding.

Do not edit files during the review.

Read `../counsel/SKILL.md` before you call Counsel. Read [references/review-contract.md](references/review-contract.md) before you prepare the review packet.

## Set the review mode

Select one mode.

- Use `diff` for a branch, pull request, or uncommitted change.
- Use `stack` for a sequence of dependent branches. Review from the base branch to the top branch.
- Use `design` for a public API or architecture decision. Use one complete review request.
- Use `performance` for a performance change. Include matched before-and-after evidence.

## Do your review first

Read the exact diff and each changed file in full. Read the call sites and the owner modules. Reproduce or inspect the reported behavior when this is possible.

Do not use Counsel as a substitute for source inspection or tests. Counsel must challenge a grounded candidate, not invent the task context.

For Effect code, read `../effect/SKILL.md`. Inspect the current Effect source. Do not depend on old API knowledge.

For an owned dependency, inspect its source. Assign the repair for a valid gap to the lowest owner. Do not approve a downstream workaround only because it already exists. An owned package is in the same workspace or under the user's control.

## Build one complete context packet

Give Counsel enough information to make an independent decision.

Include all applicable items:

- The repository path.
- The exact base and head revisions.
- The exact diff or changed files.
- The user request or ticket contract.
- The acceptance checks and non-goals.
- The product and compatibility invariants.
- The relevant source paths and cached dependency paths.
- The full path of [references/review-contract.md](references/review-contract.md).
- The candidate design and rejected alternatives.
- The test results and runtime evidence.
- The resource and performance limits.
- The owning package or branch for each change.
- The prior finding and repair evidence for round two.

State that the review is read-only. Ask Counsel to use full paths and line numbers. Ask Counsel to report no blocker when it finds no blocker.

## Request the review

Write the packet to a unique temporary prompt file when the packet is long. Run:

```bash
prompt_path="$(mktemp -t counsel-review)"
# Write the complete context packet to "$prompt_path".
okra counsel --deep -f "$prompt_path"
```

Use the correct `--from` value for the active agent. Read the output path from standard output. Read the target output file, `claude.md` or `codex.md`. Read the target error file when the command fails.

Give Counsel enough time to finish. Do not set an artificial short limit.

## Validate every finding

Open every cited file. Check the cited lines and the full control flow. Reject a finding when the source does not support it.

Check the following areas:

- The explicit contract and product behavior.
- Type, error, requirement, and scope preservation.
- Boundary decoding and domain modeling.
- Lifecycle, cleanup, interruption, and hidden effects.
- Race conditions, ordering, rollback, and offline behavior.
- Data integrity, wire compatibility, and public API compatibility.
- The proof quality of tests and benchmarks.
- Minimality and each slop class in the review contract.

Do not use a finding quota. Do not expand the work into unrelated cleanup. Separate pre-existing issues from issues in the reviewed change.

## Control the review rounds

Use a maximum of two Counsel rounds for one checkpoint.

A checkpoint is one reviewed unit. It can be a branch, a pull request, or one entry in a stack. This two-round workflow is the bounded exception to the one-shot rule in the Counsel skill.

Round one reviews the full packet. Round two reviews only the accepted findings, the repairs, the final diff, and the new proof. Tell Counsel that round two is the final allowed round.

If the user requested implementation, end the read-only review before you apply accepted repairs. Then start round two. If the user requested only a review, report the findings and stop.

Use one complete round for a design gate. Use a second round only when the first round identifies a concrete blocker and the user permits implementation before the gate closes.

Do not start a third round unless the user explicitly changes the limit.

## Report the result

Lead with the verdict. Use these groups:

1. `Blockers`: A correctness or contract failure that must stop merge or release.
2. `Major`: A likely defect, ownership error, or costly slop issue.
3. `Minor`: A local slop issue with a small and clear repair.
4. `Optional`: A valid improvement that is outside the minimum correct change.
5. `Rejected findings`: A Counsel claim that the source does not support.

For each accepted finding, give:

- The severity.
- The slop or correctness class.
- The full file path and line number.
- The violated invariant.
- The smallest correct repair.
- The correct owner.

Also report the review round count, the proof status, and the Counsel output path.

If the result has no blocker, say this clearly. Do not convert optional cleanup into a merge condition.
