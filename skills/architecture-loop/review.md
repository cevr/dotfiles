# Review pass

Every pass runs one **review** agent per workspace package, beside the architecture areas. The areas look for structure; the review agents read the code and the tests line by line for slop and test value.

## Criteria

Read these in full before the first file:

- `~/.claude/skills/code-review/references/review-contract.md`: correctness, minimality, each slop class, and the finding test.
- `~/.claude/skills/code-review/references/test-audit.md`: the value bar, the authoring gate, the junk patterns, the retention bar, the candidate evidence and the repair shape.
- `~/.claude/skills/writing-tests/SKILL.md`: tests cover behavior users depend on, not implementation details or coverage.
- The testing section of the project's `AGENTS.md`/`CLAUDE.md`, and `NORTH_STAR.md`.

## Method

1. Read every source file of the package, then every test file. A package over about 15k lines splits by directory across two agents; each names its half.
2. Source: report each slop instance that passes the finding test. Group repeats of one pattern into one finding with every site listed.
3. Tests, per file: which user-facing behavior each `describe` protects; tests that fail the value bar (asserting a mock, restating the implementation, a snapshot of internals, a duplicate of a stronger test, a name that says what is called instead of what happens); fix-shaped files and god tests; tests at the wrong tier. A deletion or move carries the full candidate evidence from `test-audit.md`.
4. Speed: the slowest test files and why (a real process, a browser per case, a fixed wait). A slow test that a lower tier could carry is a finding.
5. Gaps: user-facing behavior with no test that would fail if it broke. Name the behavior and the tier the test belongs at.

## Report

`<pass dir>/review-<package>.md`: a slop table (id, slop class, file:line or sites, repair), a test table (id, file, verdict keep/delete/merge/move/rename, evidence), a gap list, the slowest tests, and the files read. Ids are `R<N>-<package>-<k>`. Triage folds them into the package's batch; a pure test cleanup may be its own batch.
