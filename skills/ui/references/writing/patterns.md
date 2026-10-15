# Copy patterns

Templates for destructive flows and status copy, and the rules for plurals and locale formatting.

Implementation: [web](../../platforms/web/writing.md) · [Apple](../../platforms/apple/writing.md) · [Android](../../platforms/android/writing.md)

## Destructive flows

| Situation | Copy |
| --- | --- |
| Reversible, frequent action | Toast: "Project archived" with an `Undo` action |
| Irreversible, one item | Title: "Delete 'Q3 report'?" Body: "This permanently deletes the report and its 4 comments." Buttons: `Delete report`, `Cancel` |
| Irreversible, many items | Title: "Delete 12 files?" Body: "You can't undo this." Buttons: `Delete 12 files`, `Cancel` |
| Affects other people | Body names who: "The 8 members of Design lose access." |
| Account, workspace or repository | Field label: "Type 'acme-web' to confirm". The button stays disabled until it matches |

An undo toast carries an action, so how long it stays on screen is set by [accessibility](../accessibility/motion-and-zoom.md#autoplay-and-timed-ui). **Web:** building one with Sonner is in [Sonner](../../platforms/web/sonner.md).

## Status copy

| State | Pattern | Example |
| --- | --- | --- |
| In progress | Verb in `-ing` plus the object | "Saving changes…", "Loading invoices…" |
| Done | Object plus past-tense verb, no "successfully" | "Changes saved", "Invite sent to sam@example.com" |
| Failed | What didn't happen, then the next step | "Changes not saved. Check your connection and try again." |
| Unavailable | Why, and what unlocks it, beside the control | "Add a payment method to publish" |
| Partial | Counts for both outcomes | "9 of 12 files uploaded. Retry 3 failed files" |

Keep the in-progress and done strings parallel, so "Saving changes…" resolves to "Changes saved".

## Plurals and placeholders

Write one message per sentence. The variable sits inside the sentence, so the translator can move it:

| Key | English |
| --- | --- |
| `invite.sent` | `{name} invited you to {project}` |
| `inbox.count`, exactly 0 | No new messages |
| `inbox.count`, category `one` | `{count}` new message |
| `inbox.count`, category `other` | `{count}` new messages |

Plural categories come from CLDR: `zero`, `one`, `two`, `few`, `many`, `other`. English uses `one` and `other`; a translator adds `few` or `many` where the language needs them, and Chinese uses only `other`. A category is grammar, not a number: `one` can cover 21 in Russian, and English never selects `zero`. An exact-number message such as "No new messages" is a separate sentence, written as an exact match where the format has one, otherwise chosen in code.

## Locale formatting

Never hand-build a number, date or list. Pass the user's locale to the platform's formatter:

| Value | `en-US` output |
| --- | --- |
| Currency (EUR) | `€4,320.00` |
| Unit (12 megabytes) | `12 MB` |
| Date, medium style | `Jun 30, 2026` |
| Relative time, one day back, named | `yesterday` |
| List, conjunction | `Ana, Ben, and Cy` |

A list formatter follows each locale's own comma and conjunction rules, so never join names with `", "` and `" and "` by hand.
