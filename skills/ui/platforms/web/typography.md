# Typography on the web

How the [typography](../../references/typography/index.md) rules are built in CSS. The rules and their values live there; this file holds the CSS that needs more than a line. Every declaration with its Tailwind 4 utility is in [typography-css.md](typography-css.md). Write every fix in the project's styling system.

## Measured on the web

On top of the neutral [measured values](../../references/typography/index.md#measured-not-preferred), two web values are findings when missed: `16px` input text on iOS ([iOS input zoom](#ios-input-zoom)) and body `font-size` in `rem`.

## Units

| Unit | Behavior |
| --- | --- |
| `px` | Fixed |
| `em` | Scales with the current font size |
| `rem` | Scales with the root font size |
| `%` on `font-size` | Relative to the parent's font size, behaves like `em` |

Set `font-size` in `rem` so the reader's browser font size still applies. Set `line-height` unitless and `letter-spacing` in `em`, so both follow the font size.

## Type scale

Tailwind's `text-xs` through `text-9xl`, each pairing a size with a line height, is a solid ready-made scale. The neutral [role-based scale](../../references/typography/spacing-and-sizing.md#type-scale) as custom properties:

```css
:root {
  --text-caption: 0.8125rem;
  --text-body: 1rem;
  --text-heading: 1.125rem;
  --text-title: 1.5rem;
  --text-display: 2.25rem;
}

h1 { font-size: var(--text-display); }
h2 { font-size: var(--text-title); }
h3 { font-size: var(--text-heading); }
```

In Tailwind, centralize the per-level classes in a component or `@layer base` rather than repeating them inline. Size display text with `clamp()` so it scales between breakpoints.

## Fonts and synthesis

Fallback stacks for a requested type change:

```css
/* The platform's native interface face */
html {
  font-family: system-ui, sans-serif;
}

/* Commercial brand face with safe fallbacks */
html {
  font-family: "Helvetica Now", "Helvetica Neue", Arial, sans-serif;
}
```

| Format | Notes |
| --- | --- |
| `.woff2` | Brotli compression, broadly supported. Use this on the web. |
| `.woff` | Older compression. Fallback only for very old browsers. |
| `.ttf` / `.otf` | Desktop formats with no built-in compression, so larger files. Only when there is no other option. |

How the files load is the project's concern. Subset web fonts to the scripts the product ships.

Browsers synthesize any weight or style missing from the loaded `@font-face` files. `font-synthesis: none` disables weight, style, small-cap and position synthesis together, so scope it to an isolated treatment you have verified across the fallback stack:

```css
.brand-wordmark {
  font-synthesis: none;
}
```

To disable one mode, use its longhand: `font-synthesis-weight`, `font-synthesis-style`, `font-synthesis-small-caps` or `font-synthesis-position`.

## Properties over raw tags

The CSS form of [named settings over raw tags](../../references/typography/variable-fonts-and-opentype.md#named-settings-raw-tags-for-the-rest). `font-variation-settings` silently does nothing on a non-variable fallback, where `font-weight` still picks the nearest face:

```css
/* Good: common axes and features use the properties */
.heading { font-weight: 650; }
.price { font-variant-numeric: tabular-nums; }
.id { font-variant-numeric: slashed-zero; }

/* Good: custom axis or numbered feature with no property of its own */
.heading-grade { font-variation-settings: "GRAD" 80; }
.logo { font-feature-settings: "ss01" 1; }

/* Bad: weight via raw tag breaks on fallback fonts */
.heading { font-variation-settings: "wght" 650; }
```

Small capitals use `font-variant-caps`, super and subscripts `font-variant-position`. Leave `font-optical-sizing` at its default `auto`; hard-code `"opsz"` only when the design deliberately decouples optical size from font size.

## Measure

`65ch` measures characters directly, one `ch` being the width of the `0` in the current font; a `px` or `rem` cap is just as good. Tailwind's `max-w-xl` (`576px`), `max-w-2xl` (`672px`) and `max-w-prose` (`65ch`) all land in the 60–75 character range at a `16px` body.

## Text trimming with text-box

`text-box` takes which edges to trim (`trim-both`, `trim-start`, `trim-end`) and where:

| Keyword | Trims at |
| --- | --- |
| `cap` | The cap height (top) |
| `alphabetic` | The baseline (bottom) |
| `text` | The font's own text edge, keeping room for descenders |

```css
.badge { text-box: trim-both cap alphabetic; }   /* top and bottom */
.heading { text-box: trim-start cap; }           /* only the top */
.label { text-box: trim-end alphabetic; }        /* only the bottom */
```

Supported in Chromium 133+ and Safari 18.2+, not yet Firefox. Unsupported browsers keep the default leading, so it is a progressive enhancement.

## Font smoothing on the root

Apply `-webkit-font-smoothing: antialiased` and `-moz-osx-font-smoothing: grayscale` once on the root, never per component. Tailwind's `antialiased` sets both. `text-rendering: optimizeLegibility` turns on kerning and ligatures in browsers that leave them off for long text; apply it to display sizes.

## Language and direction

Set `lang` so browsers and assistive technology pick the right quotes, hyphenation and pronunciation. Set `dir` on the document and wherever direction changes. Wrap a mixed-direction value in `<bdi>`. A long paragraph aligns to its own script with `text-align: start` plus the correct `lang` and `dir` on the paragraph element. `hyphens: auto` hyphenates by the element's `lang`; headings take `hyphens: manual`.

## Underlines

From the font's own metrics:

```css
a {
  text-underline-position: from-font;
  text-decoration-thickness: from-font;
}
```

A dotted underline on an abbreviation:

```css
abbr {
  text-decoration: underline dotted;
}
```

Or tune manually:

```css
a {
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
  text-decoration-color: var(--color-gray-1000);
  transition: text-decoration-color 200ms ease-out;
}

a:hover {
  text-decoration-color: var(--color-gray-1200);
}
```

`text-decoration-skip-ink` already defaults to `auto`; never set it to `none`.

## Selection

- `::selection` can carry brand into the reading experience, as long as the selected combination stays legible.
- `::target-text` styles the phrase a shared link scrolls to.
- The Custom Highlight API styles ranges you pick yourself, like search matches, without extra markup.
- `user-select: none` goes only on a drag or gesture surface, and on touch controls where a long-press would select the label ([mobile web](mobile.md#8-long-press-selects-button-text)).
- Gradient text (`background-clip: text`) unsets the gradient in `::selection`, or the selection renders invisible.

## Forms and editable text

- `::placeholder` styles the hint in an empty field.
- `caret-color` colors the blinking insertion bar. A fully custom caret is hard to build and rarely worth it.

### iOS input zoom

iOS Safari zooms the whole page when an input's text is smaller than `16px`. Two fixes hold `16px` and look different, so ask which one the design wants.

**Size up on mobile.** The input renders at `16px` on small screens and drops to the design size from the `sm` breakpoint up. Nothing to compensate, but the mobile input no longer matches the desktop one.

```tsx
<input className="text-base sm:text-sm" type="email" />
```

**Scale the text down.** Keep `font-size` at `16px` so Safari never zooms, then render at the intended size with a transform. Identical at every viewport, more code to maintain. Widen the element by the inverse of the scale so it still fills its container once shrunk. Divide `line-height` by the same factor so the intended leading survives. `origin-left` pins the text to the start edge, `origin-right` under RTL. Above the breakpoint, drop the transform and set the real size.

```tsx
// 13px rendered from a 16px font-size: 13 / 16 = 0.8125
<div className="flex h-10 items-center overflow-hidden rounded-[10px] bg-gray-300 px-2.5 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-blue-500">
  <input
    className="h-full w-[calc(100%/0.8125)] shrink-0 origin-left rtl:origin-right scale-[0.8125] bg-transparent text-base leading-[calc(1.125/0.8125)] outline-none sm:w-full sm:scale-100 sm:text-[13px]"
    type="email"
  />
</div>
```

`shrink-0` preserves the compensated width inside the flex wrapper. The wrapper clips the oversized layout box and draws an unscaled focus outline. Use the project's focus color and verify its contrast against the surrounding surface.

The transform shrinks the whole box, not only the glyphs, so let a wrapper draw the field's surface and keep the input transparent. A background, border or ring on the scaled element shrinks with the text and misses the intended hit area.

Other phone-specific fixes are in [mobile web](mobile.md).

## Decorative text

| Property | Effect |
| --- | --- |
| `::first-letter` | Drop cap, widely supported |
| `::first-line` | Styles only the first line |
| `initial-letter` | Sizes the drop cap; Safari needs `-webkit-initial-letter`, no Firefox yet |
| `background-clip: text` | Clips a background or gradient to the letter shapes |
| `-webkit-text-stroke` | Outlines the letters; works across modern browsers despite the prefix |
| `text-shadow` | Like `box-shadow` but follows the character shapes |

If `-webkit-text-stroke` draws lines inside the letters, the font has overlapping contours. Variable fonts often keep them unmerged, so use the static cut for stroked text.

## Before you finish

The CSS patterns behind the neutral [checklist](../../references/typography/index.md#before-you-finish):

| Pattern | Fix |
| --- | --- |
| `font-weight` value with no matching weight in the loaded `@font-face` files | Load that face or use a weight the family ships |
| `font-synthesis: none` on body or interface text | Remove it; set only the unwanted longhand after checking the fallback stack |
| `font-variation-settings: "wght"` or `"opsz"` | `font-weight`; drop `"opsz"` so `font-optical-sizing: auto` applies |
| `font-feature-settings: "tnum"` or `"zero"` | `font-variant-numeric: tabular-nums` or `slashed-zero` |
| `line-height` in `px` or `rem` | A unitless value |
| `leading-none` or `leading-tight` on a description, card body or anything that can wrap | `1.4` or more |
| `letter-spacing` in `px` | The same value in `em` |
| Body `font-size` in `px` | `rem` |
| `font-thin` or `font-light` on text under `18px` | `400` or heavier |
| `text-wrap: balance` on a paragraph | `text-wrap: pretty` |
| `text-align: justify` in application UI | `text-align: start` |
| `-webkit-line-clamp` without `display: -webkit-box` | Add `display: -webkit-box` and `-webkit-box-orient: vertical` |
| `text-decoration-skip-ink: none` | Remove it; set `text-underline-offset` or `from-font` instead |
| `<input>` with `text-sm` or `14px` and no mobile override | One of the [iOS input zoom](#ios-input-zoom) fixes |
| `-webkit-font-smoothing` or `antialiased` inside a component | Move it to the root |
| Mixed-direction value such as a name, number or URL without `<bdi>` or `dir` | Wrap it in `<bdi>` |
| `user-select: none` or `select-none` on a layout root or text container | Remove it; keep it only on a drag or gesture surface |
