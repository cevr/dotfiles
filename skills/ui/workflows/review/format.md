# Review output format

The report format for a [review](../review.md). A surface review uses every section except the two marked **Change only**.

## Scope block (Change only)

Open a change review with the scope block:

| Field | Value |
| --- | --- |
| Target | `branch`, `working`, `staged`, `pr 482` or the range as entered |
| Base ref | `origin/main` at `a1b2c3d` |
| Head ref | `refs/remotes/pr/482` at `e4f5g6h` |
| Commits | 7 committed, 2 files uncommitted |
| Files in scope | 12 after exclusions |
| Excluded | `pnpm-lock.yaml`, `src/__snapshots__/`, lockfile and snapshots |
| Surfaces expanded | `CheckoutPage`, `SettingsPanel`; 3 further `Button` consumers not expanded |

## Scope and coverage

State the exact scope, stack and styling conventions, the project convention documents found in recon and any review boundary. Then show coverage:

| Domain | Evidence inspected | Result |
| --- | --- | --- |
| Accessibility | Files, components, states or checks | Findings count or `Clear` |

Include every domain listed under **Review each discipline against its reference**. `Clear` means inspected with no actionable finding; `Not reviewed` must explain why.

In a change review, a domain with no evidence in the change scope is `Not reviewed: no evidence in the change scope`, which is a coverage statement rather than a gap.

## Findings

One table, ordered by severity, then by reach:

| Severity | Domain | Location | Before | After | Why |
| --- | --- | --- | --- | --- | --- |
| HIGH | Accessibility | `src/Dialog.tsx:42` | `<button><XIcon /></button>` | Add `aria-label="Close"` and hide the icon from the accessibility tree | The icon-only control has no accessible name |

A change review adds a `Status` column per **Classify every finding**, and the table holds only `Introduced` and `Regression` findings:

| Severity | Domain | Status | Location | Before | After | Why |
| --- | --- | --- | --- | --- | --- | --- |
| HIGH | Accessibility | Regression | `src/Dialog.tsx:42` | `aria-label="Close"` removed in this change | Restore `aria-label="Close"` on the icon-only control | The close control had an accessible name before this change and no longer does |

- **Severity** comes from **Rank by user impact**.
- **Domain** is the domain name from the coverage table.
- **Location** is `path/to/file:line`, or the exact screen and component when the artifact has no source files. In a change review, cite against the head ref named in the scope block.
- **Before** and **After** show the current implementation and an actionable replacement, each in its own cell.
- **Why** names the violated principle and its user impact.

With no findings, omit the table and state "No actionable interface findings." In a change review, state "No actionable interface findings in this change."

## Pre-existing (Change only)

`Pre-existing` findings, at most three, highest severity first, stated plainly as not this change's responsibility. Omit the section when there are none.

| Severity | Domain | Location | Issue |
| --- | --- | --- | --- |
| MEDIUM | Typography | `src/Toolbar.tsx:7` | Numeric badges use proportional figures; predates this change |

## Verification

List each check or interaction, the exact command or steps and the observed result. Separate checks that passed from checks marked **Not verified**. Note any permitted `.git` write, such as `git remote set-head origin --auto` or a `--deepen` fetch.

## Verdict

End with one of two:

- `Block`: one or more `HIGH` findings remain. Do not ship until they are fixed.
- `Approve`: no `HIGH` findings remain. Any `MEDIUM` and `LOW` findings stay in the table as work to do.

In a change review, only `Introduced` and `Regression` findings count toward the verdict.

`Approve` covers only the domains the coverage table shows as inspected. Name every `Not reviewed` domain in the verdict line.
