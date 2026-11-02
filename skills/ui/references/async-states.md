# Async States

How a region looks while its data loads, refreshes, fails, or changes. These states are part of the feature, built with the successful content from the design system's shared parts, not added at the end as text placeholders.

## Decide from the data first

Ask whether usable data exists before asking what the request is doing. Data and activity are separate: a region can hold data, be refetching, and show a refresh error at once.

| Data | Activity | Show |
| --- | --- | --- |
| Present (an empty list counts) | Idle | The content, or the designed empty state |
| Present | Refetching | The content, with a quiet freshness cue when it helps; acknowledge a refresh the user asked for |
| Present | Refresh failed | The content, with an inline error and a retry beside it |
| Present pages | Loading the next page | The rows, with progress at the footer |
| Present pages | Next page failed | The rows, with an error and retry at the footer only |
| Absent | Loading | The initial pending state |
| Absent | Failed | A blocking error for that region, with recovery |
| Absent | Offline or paused | A waiting state that says so, with a way to retry |
| Absent | Disabled or waiting on input | A not-requested or prerequisite state, never a spinner that never ends |

- Test for absence with the declared sentinel (`data === undefined`), never with truthiness or list length.
- Refresh, retry, and focus refetch never clear content or swap in a skeleton. Keep the list's scroll, selection, and focus.
- Show cached data from a previous resource only when identity and permissions allow it.

## Errors

- Default to persistent, accessible feedback beside the content or action that failed. Use a toast only when there is no inline place for it.
- A failed mutation keeps the submitted input and the content already loaded.
- Each error variant gets its own message and recovery, from the typed failures the SDK delivers (the `effect` skill's ARCHITECTURE.md, Clients). Never match on message strings, and never collapse every variant into "Something went wrong".

## Shared parts, feature meaning

The design system owns the reusable pending, error, empty, and offline parts for a page, a region, and an inline spot: layout, skeleton shapes, `status` and `alert` semantics, and the optional action. A feature owns the copy, the reading of its typed errors, the recovery action, and its content skeleton, composed from those parts. Give each substantial state its own component (`NoteDetailsContent` takes a resolved note; `NoteDetailsPending` doubles as a Suspense fallback), so another composition can reuse them.

## Keep the region still

- The pending state reuses the resolved layout's frame and anchors: the same padding, alignment, line height, and markers (a chat's message gutter is present while it loads). It shows the shape of the coming UI without inventing data or enabling actions.
- A refetch or a failed refresh leaves the content mounted where it was. A first-load error or an offline state occupies the same frame the content will.
- An error appears in a place allocated near the content, wrapping when long. It does not insert rows that push a form, transcript, or canvas away, and it does not hide or clip recovery to pass a layout check.
- Mutation progress shows on the control that started it, by the button contract in [forms](accessibility/forms.md#submit-behavior): the label stays and a spinner appears beside it, repeat presses are ignored, and busy is announced. Reserve the spinner's space so neither the button nor its neighbors move. Dimming alone does not show progress, and a separate "Saving…" row is not the default.
- A mutation settling and the resource's own lifecycle are different events. A restart request can settle while the resource still reports "restarting"; show that in the resource's status spot, and do not hold the button in a pending state to cover it.

## Verify the transitions

Hold requests pending on purpose, then step through success, failure, retry, a refresh failure with data kept, and an independent resource update. Compare text anchors and control bounds between states at desktop and narrow widths, and capture each state. Check focus, scroll, input retention, busy and error semantics, and long messages. A layout-shift score alone misses replaced content and attention jumping between positions.

---

Adapted from Fernando Rojo's [nando-skill](https://github.com/nandorojo/nando-skill) (restated, not copied: the source has no license).
