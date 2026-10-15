# Icons on the web

SVG, CSS and React implementation of [icons](../../references/icons.md). The rules, values and reasons live there; this file is the how.

## Stroke width

[Rule](../../references/icons.md#match-icon-stroke-to-text-weight). Use the library's absolute-stroke option, such as Lucide's `absoluteStrokeWidth`, or set `vector-effect: non-scaling-stroke` on the SVG's shapes, so `stroke-width` means rendered pixels.

```tsx
// Good: stroke tuned to the semibold label
<button className="flex items-center gap-2 font-semibold">
  <Plus size={16} strokeWidth={2} absoluteStrokeWidth />
  New project
</button>

// Bad: 1.5px stroke against a bold label
<button className="flex items-center gap-2 font-bold">
  <Plus size={16} strokeWidth={1.5} absoluteStrokeWidth />
  New project
</button>
```

Size inline icons in `em` (`1em`–`1.25em`, or `size-[1em]`) so they follow the text size.

## currentColor and state

[Rule](../../references/icons.md#one-glyph-recolored-per-state). Icons use `currentColor`; strip hardcoded `fill="#666"` to `currentColor` when importing.

```html
<svg fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">…</svg>
```

```css
/* Use the project's color tokens */
.icon-button { color: var(--icon-muted); }
.icon-button:hover { color: var(--icon-strong); }
.icon-button[aria-pressed="true"] { color: var(--icon-active); }
.icon-button:disabled { opacity: 0.4; }
```

```html
<!-- Tailwind, with the project's token names -->
<button class="text-icon-muted hover:text-icon-strong aria-pressed:text-icon-active disabled:opacity-40">
  <BookmarkIcon />
</button>
```

In plain CSS, gate the `:hover` rule behind `@media (hover: hover) and (pointer: fine)` as in [mobile web](mobile.md#1-hover-state-stuck-after-tap).

A decorative icon beside a text label takes `aria-hidden="true"`; an icon-only button gets its accessible name from the button (`aria-label` or visually hidden text), not from the SVG. The naming rules are in [accessibility](../../references/accessibility/index.md).

## Outline and fill variants

[Rule](../../references/icons.md#outline-default-fill-active).

```tsx
// Good: variant communicates state
<TabIcon variant={isActive ? "solid" : "outline"} />

// Bad: filled everywhere, so the active tab has no state signal
<TabIcon variant="solid" />
```

The cross-fade is in [motion recipes](motion-recipes.md#icon-cross-fade).

## RTL mirroring

[Rule](../../references/icons.md#icons-in-rtl).

```css
[dir="rtl"] .icon-directional {
  scale: -1 1;
}
```

```tsx
// Tailwind
<ChevronRightIcon className="rtl:-scale-x-100" />
```

Always SVG, never raster: an `<img src="icon.png">` can't take `currentColor`, scales soft and can't be restroked.

## Before you finish

| Detection | Fix |
| --- | --- |
| `fill="#..."` or `stroke="#..."` inside an icon SVG | `currentColor` |
| `strokeWidth` without `absoluteStrokeWidth` (or `vector-effect: non-scaling-stroke`) on an icon drawn below its grid size | Add it, so the stroke matches the table |
| Icon SVG beside a visible label with no `aria-hidden` | `aria-hidden="true"` |
| Two icon libraries imported in one toolbar or component | One library |
| Directional icon with no `rtl:` or `[dir="rtl"]` flip | Add one |
| `.png` or `.jpg` used as a UI icon | SVG |
