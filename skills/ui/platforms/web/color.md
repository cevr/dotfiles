# Color on the web

How the [color](../../references/color/index.md) rules are built in CSS and Tailwind. The rules, thresholds and ramp properties live there; this file holds the notations, the CSS that implements them and the web-only patterns.

## Notations

| Notation | Good for | Weakness |
| --- | --- | --- |
| Hex | Universal support, compact, what design tools hand you | Opaque. No channel is readable or editable by hand |
| `rgb()` | Same reach as hex, readable alpha | Channels do not correspond to anything a designer thinks about |
| `hsl()` | Channels look like design controls | Its lightness is not perceptual and its hue drifts; a ramp built by varying lightness bunches at one end and shifts hue |
| `oklch()` | Perceptually uniform lightness, stable hue, predictable ramps | Baseline 2023, so very old browser matrices need a fallback |

Match the project's notation; for a new system `oklch()` is the best default ([color formats](../../references/color/color-formats.md#choosing-a-space)).

```css
oklch(L C H)          /* lightness 0–1, chroma 0–~0.4, hue 0–360 */
oklch(L C H / alpha)  /* alpha uses a slash, never a comma */
```

## Converting

When [conversion is in scope](../../references/color/color-formats.md#converting), leave the CSS keywords alone (`currentColor`, `inherit`, `transparent`, `initial`, `unset`) and convert the stops inside a gradient without touching its interpolation method:

```css
/* Before */
color: #3b82f6;
border: 1px solid rgba(0, 0, 0, 0.1);

/* After */
color: oklch(0.623 0.188 259.815);
border: 1px solid oklch(0 0 0 / 0.1);
```

## Gamut

The sRGB value first, the [P3 enhancement](../../references/color/color-formats.md#gamut) only where it will render:

```css
.success {
  background: #11ad32; /* oklch(0.65 0.2 145), inside sRGB */
}

@media (color-gamut: p3) {
  .success {
    background: oklch(0.65 0.27 145);
  }
}
```

For browser matrices predating `oklch()` support, the same layering works with `@supports`:

```css
.accent {
  background: #3b82f6;
}

@supports (color: oklch(0 0 0)) {
  .accent {
    background: oklch(0.62 0.19 259);
  }
}
```

Check the project's actual browser matrix before adding this. On a modern baseline it is dead weight.

## Derived colors

- **`color-mix()`** derives one color from another, as in `color-mix(in oklab, var(--color-accent-solid) 15%, white)` for a tinted background. Useful for states, but keep generated values out of the token layer, since a mixed color cannot be inspected in a design tool.
- **Relative color syntax** adjusts one channel of an existing color. `oklch(from var(--color-accent-solid) calc(l - 0.1) c h)` darkens the accent by hand. Powerful and easy to overuse, since a token defined by three chained derivations is unreadable.
- **`light-dark()`** puts both appearances in one declaration ([switching](#appearance-switching)).

All three, and Tailwind opacity modifiers such as `/50`, resolve at render time. Compute the resolved value with a color library, or measure the rendered result, before reporting contrast.

## Tokens

The two tiers from [token naming](../../references/color/token-naming.md#two-tiers) as custom properties:

```css
:root {
  /* Tier 1: primitives, named by hue and step. Never used directly. */
  --blue-600: #2563eb;
  --neutral-200: #e5e7eb;
  --neutral-700: #374151;

  /* Tier 2: semantics, named by role. This is what components use. */
  --color-accent-solid: var(--blue-600);
  --color-border: var(--neutral-200);
  --color-text-secondary: var(--neutral-700);
}
```

### In Tailwind projects

Tailwind v4 generates utilities from `@theme`, so names declared there become the API. Declare primitives and semantics in the same block; the `--color-*` namespace is what produces `bg-*`, `text-*` and `border-*`:

```css
@theme {
  /* Primitives */
  --color-blue-50: #eff6ff;
  --color-blue-600: #2563eb;
  --color-blue-900: #1e3a8a;

  /* Semantics: what templates should use */
  --color-accent-solid: var(--color-blue-600);
  --color-text-secondary: var(--color-neutral-700);
}
```

That yields `bg-accent-solid` and `text-text-secondary` alongside `bg-blue-600`. Tailwind prefixes every `--color-*` name with the utility, so a `text-` token doubles. Accept the doubling, or follow the convention the project already uses. Both tiers are reachable, so the discipline is a convention rather than a constraint. Templates use the semantic utilities, and a raw `bg-blue-600` in a component is the thing to flag.

Repoint semantics for dark mode in a `.dark` block outside `@theme`. Leave the block without `inline`, so utilities read the semantic variable at render time.

Opacity modifiers work on either tier, as in `bg-accent-solid/50`. But a color carrying alpha cannot be contrast-checked against a static background, because what it renders depends on what sits behind it. Use solid tokens for anything with text on it.

## Appearance switching

[Dark mode](../../references/color/palette-generation.md#dark-mode) swaps the semantic roles:

```css
:root {
  --color-bg-page: var(--neutral-50);
  --color-text-primary: var(--neutral-950);
}

.dark {
  --color-bg-page: var(--neutral-950);
  --color-text-primary: var(--neutral-50);
}
```

Use one mechanism throughout:

- **`prefers-color-scheme` alone** is correct with no theme toggle. Nothing to persist, nothing to hydrate.
- **A `.dark` class** is required as soon as users can override the system setting. The media query then sets only the initial value.
- **`light-dark()`** collapses both values into one declaration. It needs `color-scheme: light dark` and reads that property rather than a class, so a class-based toggle must set `color-scheme` too.

```css
:root {
  color-scheme: light dark;
  --color-bg: light-dark(#ffffff, #172554);
}
```

A media query setting some tokens and a class setting others gives a half-themed interface the moment a user overrides their system preference.

[Increased contrast](../../references/color/color-usage.md#light-dark-and-increased-contrast) gets its own value per appearance:

```css
:root {
  --color-accent-solid: var(--blue-600);
}

@media (prefers-contrast: more) {
  :root { --color-accent-solid: var(--blue-900); }
}

@media (prefers-color-scheme: dark) {
  :root { --color-accent-solid: var(--blue-400); }
}

@media (prefers-color-scheme: dark) and (prefers-contrast: more) {
  :root { --color-accent-solid: var(--blue-200); }
}
```

A single `prefers-contrast` block shared by both appearances darkens the color on a dark background too, lowering contrast there.

## Gradients

The three [interpolation spaces](../../references/color/color-usage.md#gradients) in CSS:

```css
background: linear-gradient(#3b82f6, #ec4899);                 /* sRGB: midpoint darkens and mutes */
background: linear-gradient(in oklab, #3b82f6, #ec4899);        /* oklab: even brightness, the default */
background: linear-gradient(in oklch, #3b82f6, #ec4899);        /* oklch: vivid, travels the hue wheel */
background: linear-gradient(in oklch shorter hue, #3b82f6, #ec4899); /* the short way round */
background: linear-gradient(in oklch longer hue, #3b82f6, #ec4899);  /* sweeps most of the spectrum */
```

## Auditing

To [inventory a palette](../../references/color/palette-structure.md#auditing-an-existing-palette), grep for hex, `rgb(`, `hsl(`, `oklch(` and the project's utility-class prefixes (`bg-`, `text-`, `border-`). Include SVG `fill` and `stroke`, chart configs and email templates.

## Before you finish

The CSS patterns behind the neutral [checklist](../../references/color/index.md#before-you-finish):

| Pattern | Fix |
| --- | --- |
| A hex, `rgb(` or `oklch(` literal in a component file where a token exists | Reuse or add the role token, in the project's notation |
| One `oklch(` value in a codebase otherwise written in hex | Write it in the established notation unless a migration is in scope |
| `var(--blue-600)` or `bg-blue-600` in a component file | Point a semantic token at the primitive and use that |
| `--color-primary` and `--color-text-primary` both defined | Rename the brand token `accent` |
| A `border` or `separator` token inside `color:`, or a `text` token inside `background:` | Add a token for the missing role |
| `hsl(` ramp values that differ only in lightness | Rebuild in OKLCH with a constant hue |
| Color tokens set under both `prefers-color-scheme` and a `.dark` class | Pick one switching mechanism and use it throughout |
| `prefers-contrast: more` overriding a color for both appearances in one block | Give each appearance its own increased-contrast value |
| Text on a color with alpha, such as `/50`, `rgba(` or `color-mix(` with `transparent` | Measure the rendered result, or use a solid token |
| `text-white` on a Tailwind `500` fill | Measure it; white on most `500` hues fails 4.5:1, so move the fill to `600` |
| `oklch()` chroma beyond sRGB with no sRGB value declared before it | Declare the sRGB value first, then the vivid one inside `@media (color-gamut: p3)` |
