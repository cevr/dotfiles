# Surfaces

Visual polish for surfaces, with the exact value each detail takes: concentric radius, optical alignment, shadow rings, image outlines, hover on hover-capable pointers and scroll containment in overlays. It applies once the underlying interaction is sound, and a polish finding never outranks a broken interaction.

## Exact values, optional polish

The values here, in [icons](icons.md) and in [motion](motion/index.md) are exact, not ranges to approximate. `cubic-bezier(0.2, 0, 0, 1)` is not `cubic-bezier(0.4, 0, 0.2, 1)`, and `0.96` is not `0.95`. The optical nudges and the concentric padding cutoff are the exceptions. They are starting points, judged by eye.

Keep the project's component library, tokens and density, and match its motion language wherever no rule gives a value. A deliberate and consistent project convention, such as a style with no shadows, is a preference and not a finding. The same detail done two ways within the project is a finding.

Text wrapping, font rendering, tabular numbers and text spacing belong to [typography](typography/index.md). Hit areas, keyboard support, ARIA and the reduced-motion requirement belong to [accessibility](accessibility/index.md). Grouping, section spacing, breakpoints and spatial RTL belong to [layout](layout/index.md), except directional icon mirroring, which is in [icons](icons.md#icons-in-rtl). Color tokens and contrast measurement belong to [color](color/index.md). Animation, transitions and their exact values belong to [motion](motion/index.md).

## Concentric border radius

Where nested surfaces share a visible, even inset, the outer radius is the inner radius plus the padding plus any border width. Past `24px` of padding, or where the padding is deliberately asymmetric, treat the layers as separate surfaces and keep each one's radius token.

```
outerRadius = innerRadius + padding + borderWidth
```

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

Where geometric centering looks off, nudge by eye. Give a button `2px` less padding on its icon side, shift a play triangle toward its point and fix asymmetric glyphs in the SVG itself.

### Buttons with text and an icon

Start the icon side at `2px` less padding than the text side, then judge by eye.

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

### Play button triangles

A triangle's geometric center sits left of its visual center, so shift it toward its point:

```css
.play-button svg {
  transform: translateX(2px); /* physical on purpose: playback icons never mirror */
}
```

### Asymmetric icons

Stars, arrows and carets carry uneven visual weight. Fix the `viewBox` or path in the SVG, so the component needs no extra offset. Where the asset cannot change, nudge its wrapper:

```tsx
<span className="translate-x-px">
  <StarIcon />
</span>
```

## Shadows for elevation, borders for structure

Where a border exists only to create depth, replace it with layered transparent `box-shadow` values. Keep borders on dividers, separators, table cells and selected states. Keep them on form inputs too, whose boundary needs 3:1 non-text contrast under [accessibility](accessibility/forms.md). Focus rings belong to [accessibility](accessibility/focus-and-keyboard.md) as well.

Forced-colors mode removes every `box-shadow`. Keep `border: 1px solid transparent` under a shadow ring so that mode still draws an edge.

### Shadow recipes

#### Light mode

Three layers. The first acts as a 1px ring, the second adds lift and the third ambient depth:

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
```

#### Dark mode

Depth shadows vanish on dark backgrounds, so dark mode keeps one white ring:

```css
/* Redefine under the project's dark selector */
--shadow-border: 0 0 0 1px oklch(1 0 0 / 0.08);
--shadow-border-hover: 0 0 0 1px oklch(1 0 0 / 0.13);
```

#### Usage

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

The transparent border keeps the box the same size as the border it replaces. Gate the `:hover` rule as in [mobile web](mobile-web.md#1-hover-state-stuck-after-tap).

## Image outlines

Give content images a `1px` outline inset by `1px`. Use `oklch(0 0 0 / 0.1)` in light mode and `oklch(1 0 0 / 0.1)` in dark. Never use a palette near-black, a tinted neutral or the accent color, because the tint shows as a colored fringe on the image edge. Skip transparent artwork such as logos and illustrations.

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

Use `outline` rather than `border` because it never changes the image's size. At `outline-offset: -1px` it sits just inside the edge and follows the corner radius.

## Touch: hover, tap highlight, overlay scroll

Hover-only styling sits behind the hover-capable pointer query, the default tap highlight is cleared where a control draws its own pressed state, and scrollable overlays contain their overscroll. The query and recipes live in [mobile web](mobile-web.md#1-hover-state-stuck-after-tap) ([tap flash](mobile-web.md#2-grayblue-flash-on-tap), [overscroll](mobile-web.md#6-pull-to-refresh-hijacks-scroll)).

## Before you finish

| Detection | Fix |
| --- | --- |
| Padded parent and child with the same `rounded-*` or `border-radius` | Add the padding to the outer radius |
| `box-shadow: 0 0 0 1px` ring with no `border` beside it | `border: 1px solid transparent` |
| `outline-slate-*`, `outline-zinc-*` or a hex outline color on `img` | `outline-black/10` and `dark:outline-white/10` |

Touch checks (hover query, tap highlight, overscroll) are in [mobile web](mobile-web.md#never-ship). Icon checks are in [icons](icons.md#before-you-finish). Motion checks are in [motion](motion/index.md).

## Reporting

**Severity.** `HIGH` breaks an interaction, as a hover state stuck on touch does. Two of the [cross-discipline review](../workflows/review.md)'s escalation triggers land in this polish domain and are `HIGH` on sight. One is motion that ignores `prefers-reduced-motion`, and the other is a state change carried by motion alone; both are judged under [motion](motion/index.md). `MEDIUM` is a visible inconsistency in surfaces, icons or motion. `LOW` is isolated polish.

**Verification.** Without a browser, read every state the component defines from the code, such as hover, pressed, selected, loading and empty. With one, walk each state. Report every check you could not run as `Not verified`.

**Format.** Group findings under the principle each violates, ordered by severity, one row per root cause listing every location it appears in:

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |

`Location` is `path/to/file:line`. `Why` names the principle and the user impact.

End with `Block` when any `HIGH` remains, `Approve` otherwise, leaving the rest in the table as work to do. Never `Approve` coverage you did not inspect. With nothing to report, state "No actionable UI-polish findings" and report verification.
