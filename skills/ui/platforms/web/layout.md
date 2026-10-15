# Layout on the web

CSS, Tailwind and DOM implementation of [layout](../../references/layout/index.md). The rules, values and reasons live there; this file is the how. Phone-specific viewport, safe-area and touch fixes are in [mobile web](mobile.md).

## Grouping and alignment

### Group with space

[Rule](../../references/layout/grouping-and-alignment.md#group-with-space-not-lines).

```css
/* Good: spacing alone communicates the grouping */
.field-group { display: flex; flex-direction: column; gap: 8px; }
.form { display: flex; flex-direction: column; gap: 24px; }

/* Bad: uniform spacing plus lines to compensate */
.form > * { margin-bottom: 12px; border-bottom: 1px solid var(--separator); }
```

```html
<!-- Good: Tailwind -->
<div class="space-y-6">
  <div class="space-y-2">…field group…</div>
  <div class="space-y-2">…field group…</div>
</div>
```

### Controls distinct from content

[Rule](../../references/layout/grouping-and-alignment.md#keep-controls-distinct-from-content).

```html
<!-- Bad: action looks exactly like the description text next to it -->
<p class="text-zinc-600">Your trial ends soon. Upgrade now</p>

<!-- Good: the underline marks the action -->
<p class="text-zinc-600">Your trial ends soon.</p>
<button class="font-medium underline underline-offset-2">Upgrade now</button>
```

### Shared edges

[Rule](../../references/layout/grouping-and-alignment.md#align-to-shared-edges). Numbers in tables take `text-align: end`, text takes `text-align: start`.

```css
/* Good: one shared leading edge, one indent step */
.section { padding-inline: 24px; }
.section .child { margin-inline-start: 16px; }

/* Bad: three unrelated leading edges in one column */
.header { padding-inline-start: 20px; }
.list-item { padding-inline-start: 14px; }
.footer { padding-inline-start: 24px; }
```

### Logical properties

[Rule](../../references/layout/grouping-and-alignment.md#leading-and-trailing-for-anything-that-mirrors). Reserve physical `left` and `right` for physical geometry such as safe-area insets.

| Physical | Logical |
| --- | --- |
| `margin-left` | `margin-inline-start` |
| `padding-right` | `padding-inline-end` |
| `left: 0` | `inset-inline-start: 0` |
| `text-align: left` | `text-align: start` |
| `border-right` | `border-inline-end` |
| `float: left` | `float: inline-start` |
| `border-top-left-radius` | `border-start-start-radius` |

```html
<!-- Good: Tailwind logical utilities -->
<div class="ms-4 pe-6 text-start">…</div>

<!-- Bad: breaks in RTL -->
<div class="ml-4 pr-6 text-left">…</div>
```

Flex rows and grid columns follow the inline direction, so they mirror under `dir="rtl"` on their own. Physical values inside them do not mirror, and neither do `translateX`, `background-position` or anything hand-positioned with `left` and `right`: give each a `[dir="rtl"]` override.

### DOM order is visual order

[Rule](../../references/layout/grouping-and-alignment.md#order-by-importance). Never move content out of source sequence with `order`, `row-reverse` or grid placement: keyboard focus and screen readers follow the DOM.

```html
<!-- Good: primary fact first, detail demoted -->
<div>
  <p class="text-2xl font-semibold">$4,320.00</p>
  <p class="text-sm text-zinc-500">Available balance</p>
</div>

<!-- Bad: the key fact sits last, below the metadata -->
<div>
  <p class="text-sm">Account 4402 · Opened 2019 · Standard tier</p>
  <p class="text-sm">Last statement: June 30</p>
  <p class="text-sm">Balance: $4,320.00</p>
</div>
```

## Spacing and adaptivity

### Control clearance

[Rule](../../references/layout/spacing-and-adaptivity.md#borderless-controls-need-more-clearance).

```html
<!-- Good: bordered buttons at 12px -->
<div class="flex gap-3">
  <button class="rounded-lg border px-4 py-2">Cancel</button>
  <button class="rounded-lg bg-blue-600 px-4 py-2 text-white">Save</button>
</div>

<!-- Bad: three borderless icon buttons packed at 4px -->
<div class="flex gap-1">
  <button><TrashIcon /></button>
  <button><ArchiveIcon /></button>
  <button><ShareIcon /></button>
</div>
```

### Inset action bar

[Rule](../../references/layout/spacing-and-adaptivity.md#inset-buttons-from-the-edges).

```css
/* Good: inset action bar */
.action-bar {
  padding-inline: 16px;
  padding-bottom: calc(16px + env(safe-area-inset-bottom));
}
.action-bar button { width: 100%; }

/* Bad: button glued to three edges, and 100vw adds the scrollbar width */
.action-bar button {
  width: 100vw;
  position: fixed;
  bottom: 0;
}
```

### Peeking scroller

[Rule](../../references/layout/spacing-and-adaptivity.md#hint-at-hidden-content). `100%` is the container's content box; `scroll-padding` keeps snapped items on the content edge. A hover-only `title` attribute is not a way to the full text of a truncated value.

```css
.scroller {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  padding-inline: 24px;
  scroll-padding-inline: 24px;
  scroll-snap-type: x mandatory;
}
.scroller > * {
  flex: 0 0 calc(100% - 12px); /* content box + 12px gap - 24px peek */
  scroll-snap-align: start;
}
```

```html
<!-- Tailwind: the same 24px peek -->
<div class="flex gap-3 overflow-x-auto px-6 scroll-px-6 snap-x snap-mandatory">
  <div class="w-[calc(100%-12px)] shrink-0 snap-start">…</div>
  <div class="w-[calc(100%-12px)] shrink-0 snap-start">…</div>
</div>
```

### Full bleed, safe areas, sticky headers

[Rule](../../references/layout/spacing-and-adaptivity.md#content-bleeds-controls-float). `env(safe-area-inset-*)` is non-zero only when the viewport meta includes `viewport-fit=cover` ([mobile web](mobile.md#7-content-stops-at-the-notch)).

```css
/* Good: full-bleed media inside a constrained article */
.article {
  display: grid;
  grid-template-columns: 1fr min(65ch, calc(100% - 48px)) 1fr;
}
.article > * { grid-column: 2; }
.article > .full-bleed { grid-column: 1 / -1; }
```

Safe-area insets are physical, so a floating button pairs each physical side with its own inset and overrides it in RTL:

```css
.fab {
  position: fixed;
  right: calc(16px + env(safe-area-inset-right));
  bottom: calc(16px + env(safe-area-inset-bottom));
}
[dir="rtl"] .fab {
  right: auto;
  left: calc(16px + env(safe-area-inset-left));
}

/* Sticky header never covers an anchor target or a focused element */
html { scroll-padding-block-start: var(--header-height); }
```

### Container queries

[Rule](../../references/layout/spacing-and-adaptivity.md#hold-structure-until-it-breaks). Write media queries in `rem` or `em` where the codebase allows ([zoom](../../references/accessibility/motion-and-zoom.md)).

```css
/* Good: component adapts to its container */
.card-list { container-type: inline-size; }
@container (width < 400px) {
  .card { grid-template-columns: 1fr; }
}

/* Bad: viewport media query breaks the card inside a narrow sidebar */
@media (max-width: 768px) {
  .card { grid-template-columns: 1fr; }
}
```

A query styles only descendants of the container, never the container itself. `container-type: inline-size` adds size containment, so the container no longer takes its width from its content. A shrink-to-fit container such as a flex item with no width, an inline-block or an absolutely positioned box collapses to zero.

### Growth and clipping

[Rule](../../references/layout/spacing-and-adaptivity.md#plan-for-growth-and-clipping).

```css
/* Good: label defines the size, and the row wraps */
.button { padding-inline: 16px; max-width: 100%; }
.button-row { display: flex; flex-wrap: wrap; gap: 12px; }

/* Bad: German will overflow or truncate */
.button { width: 96px; overflow: hidden; }
```

- A grid track or flex child refuses to shrink below its content's minimum width (`min-width: auto`). Use `grid-template-columns: minmax(0, 1fr)` and `min-width: 0` on flex children.
- Use `min-height` where a floor is needed; pair `max-height` with `overflow-y: auto` where a box caps its height.
- Size full-height panes with `100dvh`, not `100vh`, which ignores mobile browser toolbars ([mobile web](mobile.md#3-layout-has-the-wrong-height)).
- Give a modal `max-height: 100dvh`, a scrolling body and an action row outside the scroll area.

## Before you finish

| Detection pattern | Fix |
| --- | --- |
| `grid-template-columns: … 1fr` or a flex child holding long text or a wide table, overflowing its track | `minmax(0, 1fr)` on the track, `min-width: 0` on the flex child |
| `width: 100vw` | `width: 100%`; `100vw` includes the scrollbar and scrolls horizontally on desktop |
| `height: 100vh` on a full-height mobile pane | `100dvh`, so the browser toolbar and keyboard never cover the bottom |
| `height:` with a fixed length on a box holding text | `min-height`, or `max-height` with `overflow-y: auto` |
| `@media (max-width: …)` inside a reusable component | `@container` on the component's parent |
| `container-type: inline-size` on a flex item, inline-block or absolute element with no width | Give it a definite width; size containment collapses a shrink-to-fit box to zero |
| `env(safe-area-inset-*)` with no `viewport-fit=cover` in the viewport meta | Add it, or the insets resolve to `0` |
| `inset-inline-*` or `*-inline-*` combined with `safe-area-inset-left` or `-right` | Physical `left` or `right` with the matching inset, plus a `[dir="rtl"]` override |
| `ml-*`, `mr-*`, `pl-*`, `pr-*`, `left-*`, `text-left` on mirrored UI | `ms-*`, `me-*`, `ps-*`, `pe-*`, `start-*`, `text-start` |
| `float: left` on mirrored UI | `float: inline-start` |
| `translateX` or `background-position: left` on mirrored UI | A `[dir="rtl"]` override; neither has a logical form |
| `order`, `flex-direction: row-reverse` or explicit grid placement reordering content | Reorder the DOM |
| Sticky header with no `scroll-padding-block-start` | Set it to the header height |

Verify in a browser at every supported width, 320px, 200% zoom and under `dir="rtl"`.
