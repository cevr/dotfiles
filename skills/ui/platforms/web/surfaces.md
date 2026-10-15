# Surfaces on the web

CSS and Tailwind implementation of [surfaces](../../references/surfaces.md). The rules, values and reasons live there; this file is the how.

## Concentric border radius

[Rule](../../references/surfaces.md#concentric-border-radius).

```css
/* Good: concentric radii */
.card {
  border-radius: 20px; /* 12 + 8 */
  padding: 8px;
}
.card-inner {
  border-radius: 12px;
}

/* Bad: same radius on both */
.card {
  border-radius: 12px;
  padding: 8px;
}
.card-inner {
  border-radius: 12px;
}
```

```tsx
// Good: outer radius accounts for padding
<div className="rounded-2xl p-2">       {/* 16px radius, 8px padding */}
  <div className="rounded-lg">          {/* 8px radius = 16 - 8 */}
    ...
  </div>
</div>

// Bad: same radius on both
<div className="rounded-xl p-2">
  <div className="rounded-xl">
    ...
  </div>
</div>
```

## Optical alignment

[Rule](../../references/surfaces.md#optical-alignment).

```css
/* Good: less padding on the trailing icon side */
.button-with-icon {
  padding-inline-start: 16px;
  padding-inline-end: 14px;
}

/* Bad: equal padding pushes the icon visually outward */
.button-with-icon {
  padding-inline: 16px;
}
```

```tsx
// Tailwind
<button className="ps-4 pe-3.5 flex items-center gap-2">
  <span>Continue</span>
  <ArrowRightIcon />
</button>
```

```css
.play-button svg {
  transform: translateX(2px); /* physical on purpose: playback icons never mirror */
}
```

Fix an asymmetric glyph in the SVG's `viewBox` or path. Where the asset cannot change, nudge its wrapper:

```tsx
<span className="translate-x-px">
  <StarIcon />
</span>
```

## Shadow rings

[Rule and values](../../references/surfaces.md#shadows-for-elevation-borders-for-structure). Forced-colors mode (Windows high contrast) removes every `box-shadow` and paints borders in the system color, so the transparent border is what draws the edge there.

```css
:root {
  --shadow-border:
    0px 0px 0px 1px oklch(0 0 0 / 0.06),
    0px 1px 2px -1px oklch(0 0 0 / 0.06),
    0px 2px 4px 0px oklch(0 0 0 / 0.04);
  --shadow-border-hover:
    0px 0px 0px 1px oklch(0 0 0 / 0.08),
    0px 1px 2px -1px oklch(0 0 0 / 0.08),
    0px 2px 4px 0px oklch(0 0 0 / 0.06);
}

/* Redefine under the project's dark selector */
--shadow-border: 0 0 0 1px oklch(1 0 0 / 0.08);
--shadow-border-hover: 0 0 0 1px oklch(1 0 0 / 0.13);
```

```css
.card {
  border: 1px solid transparent; /* forced-colors mode drops box-shadow and paints this border */
  box-shadow: var(--shadow-border);
  transition-property: box-shadow;
  transition-duration: 150ms;
  transition-timing-function: ease-out;
}

.card:hover {
  box-shadow: var(--shadow-border-hover);
}
```

Gate the `:hover` rule as in [mobile web](mobile.md#1-hover-state-stuck-after-tap).

## Image outlines

[Rule](../../references/surfaces.md#image-outlines). Use `outline` rather than `border`, because it never changes the image's size. At `outline-offset: -1px` it sits just inside the edge and follows the corner radius.

```css
:root {
  --image-outline: oklch(0 0 0 / 0.1);
}
/* Redefine under the project's dark selector */
--image-outline: oklch(1 0 0 / 0.1);

.content-image {
  outline: 1px solid var(--image-outline);
  outline-offset: -1px;
}
```

```tsx
<img
  className="outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
  src={src}
  alt={alt}
/>
```

Never `outline-slate-*`, `outline-zinc-*`, `outline-neutral-*` or a palette near-black such as `#111827`.

## Touch: hover, tap highlight, overlay scroll

Hover-only styling sits behind the hover-capable pointer query, the default tap highlight is cleared where a control draws its own pressed state, and scrollable overlays contain their overscroll. The query and recipes live in [mobile web](mobile.md#1-hover-state-stuck-after-tap) ([tap flash](mobile.md#2-grayblue-flash-on-tap), [overscroll](mobile.md#6-pull-to-refresh-hijacks-scroll)).

## Before you finish

| Detection | Fix |
| --- | --- |
| Padded parent and child with the same `rounded-*` or `border-radius` | Add the padding to the outer radius |
| `box-shadow: 0 0 0 1px` ring with no `border` beside it | `border: 1px solid transparent` |
| `outline-slate-*`, `outline-zinc-*` or a hex outline color on `img` | `outline-black/10` and `dark:outline-white/10` |

Touch checks (hover query, tap highlight, overscroll) are in [mobile web](mobile.md#never-ship).
