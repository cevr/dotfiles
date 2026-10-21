---
name: library-retro
description: "Retrospective on a library we own: read how its consumers use it, find the footguns, paper cuts, implicit contracts and slow paths, and propose ranked library changes, each proven on a real call site."
disable-model-invocation: true
---

# Library retro

You improve a library we own from the evidence of its use. Its source shows what it can do. Its **call sites** show what it costs to use. A consumer pays **tax** wherever the library is hard to use correctly: lines copied around each call, a wrapper that hides a rough edge, a cast that silences the types, a comment that says "call X first", a fix commit after a misuse that compiled. Find the tax, trace it to the library decision that causes it, and propose the change at the library that removes it for every consumer.

You change only scratch copies. The library changes once the owner picks the findings.

## 1. Fix the scope

- **Library.** Its repository, its package name, its public surface (`exports` in `package.json` and the entry modules), and its latest release. Use the local checkout on whichever host has one, else `okra repo fetch <owner>/<repo>`.
- **Consumers.** The codebases the owner named. When none is named, search every checkout on every host: `rg -l "from ['\"]<package>" ~/Developer -g '!node_modules'` on this machine and over `ssh bite-workbox`. Count each repository once: skip Rifts, worktrees and backups. Record each consumer's host, path and pinned version. Read the changelog between a consumer's version and the latest, so you do not report what a release already fixed.
- **The owner's complaint**, when there is one, goes first. The lenses in step 3 still run in full.

Done when every export is listed and every consumer has its host, path and version.

## 2. Collect the tax

Read the call sites themselves. A grep count only tells you where to read. For each export, record its call-site count and how the call sites use it. Then hunt each kind of tax, with a `file:line` for every hit:

- **Repetition.** The same lines around a call in three or more places. The library lacks the thing those lines build.
- **Wrappers.** A consumer module that wraps, re-exports or extends the library (`make*`, `with*`, `*Helpers`, a local facade). A wrapper is a vote for a different API. Read its comments and its commit message to learn why it exists.
- **Escapes.** `as` casts, `any`, `@ts-expect-error`, lint disables and `!` assertions on or near library values.
- **Warnings in prose.** Comments next to calls that say must, before, after, never, careful, workaround, hack or TODO. Each one is an **implicit contract** that the types do not hold.
- **Patches and forks.** `patches/`, `patchedDependencies`, vendored copies.
- **Fix history.** `git log -S'<export>'` and `git log --grep '<package>'` in each consumer. A commit that fixes, reverts or works around a call to the library is a misuse that compiled. Read its diff.
- **Agent sessions.** Agents hit the rough edges first. Search the consumer's transcripts (`~/.claude/projects/<consumer path with / as ->`, `~/.codex/sessions`) for type errors, test failures and retries that name the library's exports. The same error in two sessions is a paper cut.
- **Issues.** The library's open and closed issues: `gh issue list -R <owner>/<repo> --state all`.
- **Tests.** How the consumers test code that uses the library. Hand-built fakes or long setup show a missing test helper.
- **Speed.** Where the library sits on a hot path (a render, a request, a loop), measure the consumer's real path with a benchmark or a profile. A speed finding without a number is a guess. Label it so.

Done when every export has a verdict (used cleanly, used with tax, or unused) and every piece of tax has its `file:line`.

## 3. Name the defects

Group the tax into **defects**, one library decision each, with its cause at `file:line` in the library. A defect counts when two call sites show it, or one fix commit does. Run every lens:

- **Footguns.** A misuse that compiles and does the wrong thing. These are the strongest findings.
- **Implicit contracts.** An order of calls, a lifecycle, a required context, a surprising default or a magic string that only a comment or the docs state. Make it explicit: a type, a name, a required argument, or a constructor that enforces it.
- **Paper cuts.** Boilerplate, a misleading name, an argument order that invites swaps, an option bag that grew, a flag that switches behaviour where two functions would read better.
- **Diagnostics.** An error that names neither the cause nor the fix, a silent failure, or a type error a page long at the call site.
- **Missing pieces.** What the wrappers and the repetition build on top. It belongs in the library once two consumers or three call sites build it.
- **Dead weight.** Exports nobody calls and options nobody sets. Subtract them.
- **Speed.** A measured cost on a consumer's hot path.
- **End-user UX.** When the library shapes what a person sees (loading, errors, motion, focus), check which of those states it makes easy or hard to get right.

Fix each defect at the highest level that holds, on the **guardrail ladder**:

1. **API shape.** The misuse cannot be written, and each task has one supported way.
2. **Types.** The bad state does not type-check.
3. **Runtime check** at the boundary, with an error that names the cause and the fix.
4. **Lint rule** (`effect-oxlint` for Effect code) whose message names what to use instead.
5. **Docs**, for judgement calls only.

For each defect, say why each higher level does not work. Before you propose an API change, read `~/Developer/personal/dotfiles/principles/`, in particular make-impossible-states-unrepresentable, small-interface-deep-implementation, composition-over-flags, subtract-before-you-add and migrate-callers-then-delete-legacy-apis. Use the `codebase-design` skill's words for depth and seams.

Done when every defect has its library cause, its consumer evidence, its lens and its ladder level.

## 4. Prove the top fixes

Rank the defects by harm × call sites ÷ migration cost. A footgun outranks a paper cut of the same reach. We own the library and its consumers, so a breaking change is allowed. Count its migration in the cost.

Prove the top five or fewer before you report them, in a scratch branch or a Rift:

- **Before and after.** Rewrite one or two real call sites against the proposed API and show the diff. The after must read better to someone new to the library.
- **Able to fail.** For a guardrail, take the misuse from a real fix commit and show the guardrail stop it: the type error, the lint error, or the runtime error with its message. A guardrail you have not seen fail proves nothing.
- **Numbers.** For speed, the benchmark before and after a sketch of the change, with the command that ran it.

Drop the scratch work after you record the proof.

## 5. Report

Give the owner each proven finding, most harmful first:

- the defect in one sentence, and the harm in one sentence;
- the evidence: the call-site count, two or three `file:line` examples, and the fix commits or sessions;
- the fix, its ladder level, and why the levels above it do not hold;
- the proof: the before and after diff, the failing misuse, or the numbers;
- the migration: which consumers change, and how many call sites.

Then list the unproven defects in one line each, labelled as unproven. Then say what you did not cover: consumers you did not read, exports you did not check, and hot paths you did not measure.

Once the owner picks findings, file each one in the library's tracker (GitHub Issues through `gh` for a personal repository). Add to a matching open issue instead of opening a duplicate.
