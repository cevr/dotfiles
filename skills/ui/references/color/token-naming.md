# Token naming

Naming is what makes a palette usable by anyone who did not build it. For which ramps exist and what each step does, see [palette-structure.md](palette-structure.md).

Names below are written in kebab case. Each platform spells them in its own idiom: CSS custom properties (`--color-text-secondary`) on the web, asset-catalog names or `Color` extensions on Apple, `ColorScheme` roles on Android, where Material's role names replace this grammar. Implementation: [web](../../platforms/web/color.md#tokens) · [Apple](../../platforms/apple/color.md#tokens) · [Android](../../platforms/android/color.md#the-material-scheme-wins)

## Two tiers

**Primitives** name a value. They are the ramp, named by hue and step, as in `blue-600` or `neutral-200`. A primitive describes what the color *is*, so it never changes meaning between themes and is never applied directly in a component.

**Semantics** name a job. They point at a primitive and take the name of the role they fill, as in `color-text-secondary` or `color-border-subtle`. Components only ever reference this tier.

| Tier | Token | Points at |
| --- | --- | --- |
| Primitive, never used directly | `blue-600` | `#2563eb` |
| | `neutral-200` | `#e5e7eb` |
| | `neutral-700` | `#374151` |
| Semantic, what components use | `color-accent-solid` | `blue-600` |
| | `color-border` | `neutral-200` |
| | `color-text-secondary` | `neutral-700` |

The tiering is what makes theming possible. Dark mode, a white-label theme and an increased-contrast variant all repoint the semantic tier, leaving the primitives and every component untouched. A codebase applying `blue-600` directly in components has no theming seam. Adding one later means auditing every usage to work out which meant "the accent" and which just wanted blue.

Add a third, component-level tier (`color-button-danger-bg`) only where a component genuinely and intentionally diverges from the system. One component token is a documented exception; twenty mean the semantic tier is missing roles.

## The role inventory

A system is complete when every role below has a token. Build against this list rather than adding tokens as components demand them, or the palette ends up shaped like whichever screen came first.

| Group | Roles |
| --- | --- |
| Surfaces | page background, surface, raised (menus, popovers), sunken (inputs, wells), overlay scrim |
| Text | primary, secondary, disabled, inverse, on-accent |
| Borders | subtle, default, strong, focus ring, separator |
| Accent | subtle background, border, solid, solid hover, text |
| Status | per status shipped: subtle background, border, solid, text |

Separator and border are separate roles even when they share a value today. A separator divides content; a border encloses a control. They diverge the first time someone restyles inputs, and a system that conflated them gets untangled at that moment.

## Naming grammar

Use one shape and never deviate. Neutral roles lead with the property, as `color-{bg|text|border}-{variant}-{state}`. Accent and status roles lead with the role, as `color-{accent|danger|…}-{subtle|border|solid|text}-{state}`:

`color-bg-surface` · `color-text-secondary` · `color-border-strong` · `color-accent-solid-hover` · `color-danger-subtle` · `color-accent-text`

Pick one word per concept and use only that word. Consistency matters more than the vocabulary. A reader who has seen `color-text-primary` must be able to guess `color-text-disabled` without looking:

| Concept | Pick one | Never mix in |
| --- | --- | --- |
| Foreground | `text` | `fg`, `foreground`, `content`, `ink` |
| Background | `bg` | `background`, `surface` as a synonym, `fill` |
| Edge | `border` | `stroke`, `outline`, `line` |
| Brand color | `accent` | `primary`, `brand`, `theme` used interchangeably |

Reserve `primary` for exactly one meaning. `color-text-primary` for body text beside `color-primary` for the brand is the most common naming collision there is, and it makes every `primary` token ambiguous until you open its definition. Use `accent` for the brand and let `primary` mean "the most prominent of its group". A platform system that already fixes the word, as Material's `primary` role does, wins on its platform.

## Anti-patterns

| Name | Problem | Instead |
| --- | --- | --- |
| `color-blue-button` | Appearance at the semantic tier; lies the moment the brand changes | `color-accent-solid` |
| `color-sidebar-gray` | Named for where it was used first; the second usage makes it nonsense | `color-bg-surface` |
| `color-light-gray` | Lies in dark mode, where it is the dark one | `neutral-200` as a primitive |
| `color-text-2` | Numbered semantics carry no meaning; nobody can guess what `3` would be | `color-text-secondary` |
| `color-gray-hover` | Mixes a hue with a state and belongs to no tier | `color-bg-surface-hover` |
| `blue-600` used in a component | Skips the semantic tier and removes the theming seam | Point a semantic token at it |

**Web:** the two tiers as custom properties and in Tailwind v4 `@theme` are in [web color](../../platforms/web/color.md#tokens).
