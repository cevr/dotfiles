# Screen readers

Visually hidden content, choosing how to announce a change, live regions, hiding from assistive tech, alt text, video and audio.

Implementation: [web](../../platforms/web/accessibility.md#screen-readers) · [Apple](../../platforms/apple/accessibility.md#screen-readers) · [Android](../../platforms/android/accessibility.md#screen-readers)

## Visually hidden content

Context sighted users get from the layout can go to assistive tech without being drawn: "Opens in new tab", a table caption, or an icon-only control's name where a direct label isn't an option. Hide such content visually only. Removing it from layout entirely removes it from assistive tech too.

**Web:** the `.sr-only` pattern (Tailwind `sr-only`), never `display: none`; the CSS and why each line matters are in the [web file](../../platforms/web/accessibility.md#visually-hidden-content).

## Choosing how to announce a change

Work down this list and stop at the first match:

1. **Focus moves there anyway**, as with an opened modal or the first invalid field. Nothing extra needed; the focus move is the announcement.
2. **Tied to a specific control**, such as a field error or character count: a description on the control, announced with the field.
3. **Non-urgent, not tied to a control**, such as a toast, "Saved", a result count or a loading state: a polite announcement.
4. **Urgent and not tied to a control**, such as a form-level failure or session expiry: an assertive announcement.

A state change on a control (selected, expanded, on) is the control's own state, read when it changes, not an announcement.

## Live regions

A live region is an area whose changes the screen reader reads without focus moving. Polite waits for a pause in speech; assertive interrupts immediately and is for errors and urgent problems only. Platforms without live regions post an announcement instead, with the same politeness choice.

Rules for reliable announcements:

- For repeated polite updates, keep a stable empty region present before changing its text. Inserting a new polite region with its content is announced inconsistently.
- Dynamically inserted assertive content is usually announced, but behavior varies. Test the target screen readers.
- Default to polite. Assertive interrupts whatever the user was reading.
- Keep messages short and self-contained. The whole region is re-read on change.
- Never move focus to a toast. Announce it and leave focus where the user is working.

For loading states: mark the updating region busy, announce "Loading…" politely, then announce the outcome ("Loaded, 12 results").

**Web:** `role="status"` and `role="alert"` markup is in the [web file](../../platforms/web/accessibility.md#live-regions).

## Hiding from assistive tech

Hide decorative icons and content duplicated for visual effect from assistive tech; hiding removes the element and everything inside it. Never hide a focusable element or its ancestor, which creates stops you can Tab to that do not exist for a screen reader. Hiding something interactive means removing it from keyboard focus too.

**Web:** `aria-hidden="true"`; for an interactive subtree, `inert`.

## Alt text

Choose by purpose, not by what the image looks like:

| Purpose | Description | Example |
| --- | --- | --- |
| Decorative, or redundant with adjacent text | None: hidden from assistive tech | Logo next to the company name in text |
| Informative | Describe the meaning it adds | "Ticket QR code" |
| Functional (image is the link/button) | Describe the action or destination | Search icon → "Search", not "magnifying glass" |
| Image of text | The exact text (better: use real text) | "50% off everything" |
| Complex (chart, diagram) | Short summary, full data as a table or text nearby | "Revenue by quarter, described below" |

An image with no description at all is worse than a hidden one, because screen readers fall back to reading the file or asset name.

**Web:** `alt=""` (empty, but present) for decorative images; SVG labeling is in the [web file](../../platforms/web/accessibility.md#svg).

## Video and audio

Prerecorded video needs captions (1.2.2), and prerecorded audio needs a transcript (1.2.1). Never autoplay with sound (1.4.2), and always render playback controls.
