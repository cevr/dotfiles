# Review

Review an interface across every discipline and consolidate one ranked verdict. The target is either a **surface** (a file, component, screen, flow or the whole repository) or a **change** (a branch, pull request, commit range or uncommitted work). Resolve which first, then route the interface to each discipline's reference, collect the evidence and report in one table.

Orchestration is all this mode owns. Accessibility rules live in [accessibility](../references/accessibility/index.md), structure in [layout](../references/layout/index.md), copy in [writing](../references/writing/index.md), type in [typography](../references/typography/index.md), color in [color](../references/color/index.md), token use in [theming](../references/theming.md), visual polish in [surfaces](../references/surfaces.md) and [icons](../references/icons.md), motion in [motion standards](../references/motion/standards.md) and content restraint in [interface judgment](../references/interface-judgment.md). Never duplicate or override their rules here.

Correctness, tests, security and performance belong to the project's general code review. Name such a concern once, point at that review and drop it.

## Evidence, not taste

Press hard on the escalation triggers and leave deliberate project choices alone. A trigger is a failure whatever the style guide says. A density, radius or voice you merely disagree with is not a finding.

The bar for reporting is evidence. The bar for `Approve` is that you inspected what you claim to have inspected.

For a change, the author is asking "did I make this worse?". Report what the change caused and stay mostly quiet about what it merely touched. Three pre-existing findings is a courtesy; thirty is a different review and one nobody asked for. Read the whole diff before forming an opinion of it. A skimmed diff produces findings about code the next hunk already fixed.

## 1. Resolve the scope

The whole invocation is the target, so `review pr 482` reviews pull request 482 and `review src/Checkout.tsx`, `review CheckoutView.swift` or `review CheckoutScreen.kt` reviews that file.

- A request naming a file, component, screen, flow or the repository is a **surface review**.
- A request naming a branch, pull request, commit range, ref, `working` or `staged` is a **change review**. [Scope resolution](review/scope-resolution.md) holds the accepted targets and how each resolves.
- A request naming nothing is a change review resolved by the default order below.

State the resolved scope in the output.

### Surface scope

Infer the screen, flow, feature or repository scope from the request and current workspace. Cover all of it in every domain, including the empty, loading, error and narrow-width states where they exist.

When the scope is too large to inspect credibly, narrow it to one complete flow. Take the one the request centers on, or failing that the entry path every user must pass through. State the boundary and what it excluded. Never imply uninspected surfaces were reviewed.

### Change scope

With no target supplied, resolve in this order and stop at the first match:

1. `HEAD` is ahead of `git merge-base origin/<default-branch> HEAD`. Review that range **plus** any uncommitted changes, stating the commit count and the uncommitted file count separately.
2. The working tree is dirty. Review the uncommitted changes.
3. Neither. There is no change to review, so follow **With no change, ask rather than invent one**.

Never resolve a change scope by guessing. A guessed diff gives the report a scope nobody can check.

Record the base commit of the resolved range as `$BASE` and name it in the scope block. Every command in this mode and its references uses it.

Exclude lockfiles, snapshots, generated output, vendored code and binaries per [Excluded paths](review/scope-resolution.md#excluded-paths), and name what you excluded. If nothing survives the exclusions, treat it as no change.

### With no change, ask rather than invent one

A clean tree with nothing ahead of the merge base means there is no change to review. Never fall back to `HEAD~1..HEAD` on your own. The last commit is whatever happened to land, often a merge or someone else's work.

Gather the facts in [Nothing to review](review/scope-resolution.md#nothing-to-review), state them, then offer these routes and wait:

- **The open pull request** on the current branch, first when there is one. A branch whose commits already landed resolves to no change, while its pull request is still exactly what the user meant.
- **The last commit**, `HEAD~1..HEAD`, named by short SHA and subject so the user sees what they would get.
- **A target they name**, such as `pr <n>`, a branch, a ref or a range.
- **A whole-repository interface audit**, which is not a change review. Run it as a surface review at repository scope, without the scope block, statuses or pre-existing section.

Where exclusions emptied the scope, name the excluded files in the offer. Never report a review of nothing as `Approve`.

## 2. Recon before judgment

Identify the platform and framework, styling system, component library, design tokens, supported viewports or devices and size classes, and any preview or test command. Write every fix in the project's own idiom, never as a request to adopt a different stack.

Then read what the project has written about its own interface: `CONTRIBUTING.md`, `CODING_STANDARDS.md`, `AGENTS.md`, `CLAUDE.md`, a design-system doc, Storybook docs, a preview or component catalog and interface ADRs. Name which you found, or that there are none.

A documented convention settles matters of taste but never excuses a trigger or a domain rule violation. What it changes is **where** you report. When a guideline or shared token is the cause, report it once against that source, with the components as its locations.

## 3. For a change: expand, read removals, classify, check intent

Skip this step for a surface review.

### A diff is not a surface

A changed file is evidence, not the review subject. Its **blast radius** is the set of surfaces it renders in; review those.

Expand one hop by default, to the direct importers and callers. Expand a second hop only for design tokens, theme values and shared primitives, where one line reaches the whole product.

Review at most five consumers in total across both hops, ordered by [the rule in Scope resolution](review/scope-resolution.md#expanding-to-consumers). State how many you did not expand, since an unstated cutoff reads as completeness.

### Read the removed lines

Regressions are invisible in the post-change state. Read the `-` side of every hunk against [Removed signals](review/removed-signals.md).

A signal is a lead, not a finding. A removal is a regression only when nothing in the change replaces it, and the owning reference decides that. Route each unmatched removal to its owner, report only what that reference confirms and status it `Regression`.

### Classify every finding

Give every finding one status:

- `Introduced`: the change created it.
- `Regression`: the change weakened something previously correct.
- `Pre-existing`: present before the change and not made worse by it.

Status by cause, not by location. A finding a changed line causes is `Introduced` or `Regression` wherever it surfaces, including an untouched consumer of a changed token. A finding the change neither created nor worsened is `Pre-existing`, even three lines from a hunk.

To check whether a line predates the change, blame the reviewed range. A `^` prefix marks a line unchanged since the base:

```bash
git blame -L <line>,<line> "$BASE"..<head-ref> -- path/to/file
```

For uncommitted work, drop the range. A line marked `Not Committed Yet` or blamed on a commit inside `$BASE..HEAD` belongs to the change.

### Hold the change to its stated intent

Read the pull request title and body, the linked issue and the commit messages, then review whether the interface delivers what they claim.

This is how you find the **incomplete** change, which a surface review misses because it inspects only the states that exist. Look for the absent ones:

- A new variant, size or theme applied to some states but not all of hover, focus, active, disabled, loading and selected.
- A new user-facing string with no entry in the translation catalogue the project maintains.
- A new component with no empty, loading, error, disabled or narrow-width state.
- A control added to one surface but not to the siblings that already carry its peers.

Do not report scope creep. Whether a change does too much is a process question, not an interface one.

## 4. Review each discipline against its reference

Read every reference below and complete each domain review before consolidation. Review in this order so foundational failures are not hidden by polish:

| # | Domain | Reference | Covers |
| --- | --- | --- | --- |
| 1 | Accessibility | [accessibility/index.md](../references/accessibility/index.md) | Keyboard and focus, semantics (ARIA, accessibility traits, semantics properties), names, forms, announcements, hit areas, motion and text size |
| 2 | Layout | [layout/index.md](../references/layout/index.md) | Grouping, alignment, reading order, responsive and adaptive structure, room for translated text |
| 3 | Writing | [writing/index.md](../references/writing/index.md) | Labels, errors, empty states, confirmations, voice |
| 4 | Typography | [typography/index.md](../references/typography/index.md) | Scale, spacing, font features, wrapping, truncation, punctuation |
| 5 | Color | [color/index.md](../references/color/index.md) | Palette, semantic tokens, contrast |
| 6 | Theming | [theming.md](../references/theming.md) | Values come from tokens, roles over palette classes, library customization, portals, distinct states |
| 7 | Surfaces and icons | [surfaces.md](../references/surfaces.md), [icons.md](../references/icons.md) | Radius, optical alignment, shadows, image outlines, icon stroke, size and states |
| 8 | Motion | [motion/standards.md](../references/motion/standards.md) | Whether it should animate, easing, duration, interruptibility, reduced motion |
| 9 | Interface judgment | [interface-judgment.md](../references/interface-judgment.md) | Whether each element earns its place; the closing pass that removes what adds nothing |

From each, take its principles, its sub-files and its verification checks. Any severity ladder or report format inside a reference is for standalone use; the ones in this file replace them.

Motion gets the standards pass here. When the scope is motion-heavy, or the user asks for a strict motion verdict, run the full [motion review](motion-review.md) and fold its confirmed findings into this report under the `Motion` domain.

If a reference cannot be read, mark that domain `Not reviewed`, name the file and continue with the rest. Do not recreate its rules from memory, substitute a neighbour or claim holistic coverage.

When two references appear to cover one issue, assign it to the owner of the underlying rule and note secondary effects in the **Why** cell.

## 5. Require evidence

Every finding cites `path/to/file:line` and shows the current implementation. When runtime behavior determines the result, source alone cannot support a visual finding and a screenshot alone cannot support a code finding.

## 6. Rank by user impact

Use one shared severity scale:

- `HIGH`: blocks a task, misleads the user, hides content or controls, causes data-loss risk or creates a repeated systemic failure.
- `MEDIUM`: meaningfully harms comprehension, efficiency, adaptability or consistency.
- `LOW`: isolated polish with limited task impact.

Within a severity, rank by how many places the finding reaches and how much one fix buys. A token or shared-component fix outranks the same symptom in one leaf.

**Escalation triggers.** Once the owning reference confirms one of these, it is `HIGH` on sight, never averaged down because the surface is minor:

- An interactive control with no accessible name.
- A keyboard-reachable control with no visible focus indicator.
- A control or path reachable by pointer or touch but not by keyboard or switch input.
- Motion or auto-playing content that ignores the reduced-motion setting.
- Content or a control clipped, overlapped or unreachable at the narrowest supported width (320pt) or the largest text size: 200% browser zoom, the largest accessibility Dynamic Type size, Android font scale 200%.
- Body or control text whose rendered contrast pair fails its required ratio.
- State or meaning carried by color alone.
- A destructive action with no confirmation, undo or distinct treatment.
- Truncated content with no way to reach the full value.
- Content or a control reachable only past a scroll edge or behind a disclosure that has no visible cue.
- An error that names no way to recover from it.
- A semantic color used against its meaning, such as the danger hue on a non-destructive action.
- A state change carried by motion alone, with no color, icon or label left behind when the animation does not run.

Triggers rank above every other finding. When more fire than the cap allows, list them first and say how many the cap excluded. A cap may shorten a report; it may never be why a blocker went unreported.

These set severity, not new rules. The owning reference decides whether the symptom is present; this list decides what it costs.

For a change, the cap and the verdict cover `Introduced` and `Regression` findings only, so a change whose only findings are `Pre-existing` is an `Approve`.

## 7. Prefer the cheaper fix

Severity says how bad a finding is; this says which fix to propose. When more than one would work, take the earliest that does:

1. **Delete.** A separator that space would carry, an animation on a high-frequency interaction, an accessibility attribute a native element or system control makes redundant, a ramp nothing imports.
2. **Use the platform.** The native element or system control and the platform's own focus treatment (the browser's focus ring, the system focus effect, the Material focus indication), in place of a custom rebuild.
3. **Reuse what the project has.** An existing token, spacing step or motion curve, before any new value.
4. **Correct the value.** The wrong easing, radius, gap or contrast pair, using the exact value the owning reference gives.
5. **Add.** A new token, a wrapper, a media query or size-class branch, an accessibility attribute the platform cannot supply.

When the code under review adds what **Delete** would fix, that is a finding, and its **After** is the deletion.

## 8. Consolidate systemic findings

One root cause is one finding, with every confirmed location in the same row. Report at most 15 findings. Never pad toward the cap; a short review or no findings is a valid result.

## 9. Verify what can be verified

**Surface review.** Run the safe, relevant checks the project offers. Inspect the rendered interface when runtime behavior or visual judgment matters, through the renderer [harness](harness.md#looking-at-it) names for the platform, judge it by [its passes](harness.md#judging-it), and report the exact command or interaction and its result.

**Change review.** Rendered verification is opt-in. Mark visual and runtime claims **Not verified** unless the project exposes a cheap preview or the user asks for a rendered review. For `working` and `branch`, the checkout already is the head, so render it in place. For any other target, render an isolated worktree such as `git worktree add /tmp/review-<n> refs/remotes/pr/<n>` and remove it when done.

Either way, a check you cannot run is **Not verified**, never a finding.

## 10. Review without mutating

Treat a review request as read-only. Do not edit source unless the user also asks you to implement the findings. When they do, keep the consolidated report as the change scope and re-run the relevant verification afterward.

A change review is read-only including the checkout. `git fetch` writes only to `.git` and is permitted. `gh pr checkout`, `git checkout`, `git switch` and `git stash` rewrite the files the author has open, so they are never permitted. Fetch pull request refs and read them in place.

## Before you finish

| Mistake | Fix |
| --- | --- |
| A separate findings section per domain | Merge them into one table ranked by severity, then reach |
| A rendering claim whose only evidence is source | Inspect the rendered state, or mark it **Not verified** |
| A missing accessible name or focus ring rated `MEDIUM` because the surface is minor | Triggers are `HIGH` on sight |
| A coverage row whose evidence cell names no file, component or check | Inspect that domain, or mark it `Not reviewed` with the reason |
| A domain marked `Clear` although its reference was never read | Mark it `Not reviewed` and name the reference |
| The same symptom in several rows, one per component | One row against the shared token or component, listing every location |
| An **After** that adds a wrapper, token or accessibility attribute | Check whether a deletion or the native element or system control fixes it first |
| A fix written in a library or styling system the project does not use | Rewrite it in the project's own idiom |
| The scope block counts only uncommitted files while `HEAD` is ahead of the merge base | Review the branch range plus the uncommitted changes, with both counts |
| A report on `HEAD~1..HEAD` the user never chose | State the facts and offer the routes in **With no change, ask rather than invent one** |
| A changed shared component with no consumer under `Surfaces expanded` | Expand to its consumers and name the ones you skipped |
| A deleted `aria-label`, `outline` or `prefers-reduced-motion`, or its native counterpart (`.accessibilityLabel`, `contentDescription`, a reduce-motion check), with no finding and no note | Route it to its owner through [Removed signals](review/removed-signals.md) |
| A `Regression` whose removed attribute reappears elsewhere in the diff | Check the [equivalent replacements](review/removed-signals.md#equivalent-replacements) first |
| A finding on an untouched consumer of a changed token statused `Pre-existing` | The change caused it, so it is `Introduced` or `Regression` |
| A line outside every hunk statused `Introduced` with no causing change named | Blame it against the reviewed range |
| `gh pr checkout` or `git switch` in the command log | Fetch the ref and read files with `git show` |
| A cited line that does not match `git show <head-ref>:path` | Cite against the head ref named in the scope block |

## Output format

The format lives in [format.md](review/format.md): the scope block for a change, scope and coverage, the findings table, pre-existing findings for a change, verification and the verdict. A review is not finished until its findings are reported there.
