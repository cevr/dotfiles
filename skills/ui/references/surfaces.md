# Surfaces Reference

Concentric radii, optical alignment, shadow systems, and image outlines. Load when building cards, buttons, containers, or reviewing surface-level polish.

Based on [jakubkrehel/make-interfaces-feel-better](https://github.com/jakubkrehel/make-interfaces-feel-better).

---

## Concentric Border Radius

Outer radius = inner radius + padding. Mismatched radii on nested elements is the #1 thing that makes interfaces feel off.

```
outerRadius = innerRadius + padding
```

```css
/* Good — concentric */
.card { border-radius: 20px; padding: 8px; }       /* 12 + 8 = 20 */
.card-inner { border-radius: 12px; }

/* Bad — same radius on both */
.card { border-radius: 12px; padding: 8px; }
.card-inner { border-radius: 12px; }
```

```tsx
// Tailwind — outer radius accounts for padding
<div className="rounded-2xl p-2">         {/* 16px radius, 8px padding */}
  <div className="rounded-lg">            {/* 8px radius = 16 - 8 ✓ */}
    ...
  </div>
</div>

// Bad — same radius
<div className="rounded-xl p-2">
  <div className="rounded-xl">            {/* looks off */}
    ...
  </div>
</div>
```

**Caveat:** If padding > ~24px, treat layers as independent surfaces — strict concentric math no longer matters at that distance.

---

## Optical Alignment

When geometric centering looks off, align optically.

### Buttons with Text + Icon

Icon side gets less padding. Rule of thumb: `icon-side padding = text-side padding - 2px`.

```css
/* Good — less padding on icon side */
.button-with-icon { padding-left: 16px; padding-right: 14px; }

/* Bad — equal padding, icon looks pushed out */
.button-with-icon { padding: 0 16px; }
```

```tsx
// Tailwind
<button className="pl-4 pr-3.5 flex items-center gap-2">
  <span>Continue</span>
  <ArrowRightIcon />
</button>
```

### Play Button Triangles

Triangles' geometric center ≠ visual center. Shift right ~2px:

```css
.play-button svg { margin-left: 2px; }
```

### Asymmetric Icons (Stars, Arrows, Carets)

Best fix: adjust the SVG `viewBox`/path directly. Fallback: nudge with `margin`/`padding`.

```tsx
// Best — fix in SVG
// Fallback
<span className="ml-px"><StarIcon /></span>
```

---

## Shadows Over Borders

For **cards, buttons, containers** that use borders for depth — replace with layered `box-shadow`. Shadows use transparency, adapt to any background. Solid borders break on varied/image backgrounds.

**Do NOT replace:** dividers (`border-b/t`), table cell boundaries, layout separators. Those stay as borders.

### Light Mode — 3-Layer System

```css
:root {
  --shadow-border:
    0px 0px 0px 1px rgba(0, 0, 0, 0.06),      /* 1px ring */
    0px 1px 2px -1px rgba(0, 0, 0, 0.06),      /* subtle lift */
    0px 2px 4px 0px rgba(0, 0, 0, 0.04);       /* ambient depth */
  --shadow-border-hover:
    0px 0px 0px 1px rgba(0, 0, 0, 0.08),
    0px 1px 2px -1px rgba(0, 0, 0, 0.08),
    0px 2px 4px 0px rgba(0, 0, 0, 0.06);
}
```

### Dark Mode — Single Ring

Layered depth shadows invisible on dark backgrounds. Simplify:

```css
--shadow-border: 0 0 0 1px rgba(255, 255, 255, 0.08);
--shadow-border-hover: 0 0 0 1px rgba(255, 255, 255, 0.13);
```

### Usage with Hover Transition

```css
.card {
  box-shadow: var(--shadow-border);
  transition-property: box-shadow;
  transition-duration: 150ms;
  transition-timing-function: ease-out;
}
.card:hover { box-shadow: var(--shadow-border-hover); }
```

### When to Use

| Shadows | Borders |
|---------|---------|
| Cards, containers with depth | Dividers between list items |
| Buttons with bordered styles | Table cell boundaries |
| Elevated elements (dropdowns, modals) | Form input outlines (accessibility) |
| Elements on varied backgrounds | Hairline separators in dense UI |
| Hover/focus states for lift |  |

---

## Image Outlines

Subtle `1px` outline with low opacity on images. Creates consistent depth alongside bordered/shadowed elements.

```css
/* Light */ img { outline: 1px solid rgba(0, 0, 0, 0.1); outline-offset: -1px; }
/* Dark */  img { outline: 1px solid rgba(255, 255, 255, 0.1); outline-offset: -1px; }
```

```tsx
// Tailwind
<img
  className="outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
  src={src} alt={alt}
/>
```

**Why outline, not border?** `outline` doesn't affect layout — no added width/height. `outline-offset: -1px` keeps it inset.

---

## Hit Area Extension

When a visible control is smaller than 24px on desktop or 44px on touch, extend its hit area with a pseudo-element. Never let adjacent hit areas overlap.

```css
.small-control {
  position: relative;
  width: 20px; height: 20px;
}
.small-control::after {
  content: "";
  position: absolute;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  width: 44px; height: 44px;
}
```

```tsx
// Tailwind
<button className="relative size-5 after:absolute after:top-1/2 after:left-1/2 after:size-11 after:-translate-1/2">
  <CheckIcon />
</button>
```

If the extended area would overlap another interactive element, shrink the pseudo-element — but keep it as large as possible without collision.

---

## Quick Reference

| Problem | Fix |
|---------|-----|
| Nested rounded elements look off | `outerRadius = innerRadius + padding` |
| Icon looks off-center in button | Icon-side padding = text-side - 2px |
| Hard borders on varied backgrounds | Layered `box-shadow` with transparency |
| Images lack depth consistency | `outline: 1px solid rgba(0,0,0,0.1)` inset |
| Small controls hard to tap | 24px minimum; prefer 44px on touch |
| Play button triangle off-center | `margin-left: 2px` on SVG |
