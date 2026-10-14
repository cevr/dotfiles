# Design Systems From a Spec

Turning a written brand or design spec (a `DESIGN.md`, a brand guide, a token sheet) into a project's theme, then proving it with a design system page. Generalized from the shadcn skill's design-system workflow; in a shadcn project the `shadcn` skill's `design-system.md` runs this end to end with its CLI. For a Figma file or design image, follow [build-design](../workflows/build-design.md). For palette ramps and contrast measurement, see [color](color/index.md).

## 1. Read the Spec Into a Working Table

Long specs exceed one read: grep headings first, then read frontmatter, Do's and Don'ts, and any Known Gaps section in full. Those hold the rules that override defaults. Extract before editing anything:

| Extract | Look for |
| --- | --- |
| Canvas and ink | canvas, surface, page floor, body text |
| Action color and states | primary, hover, active/pressed, disabled, on-primary |
| Secondary actions | secondary fill, text, border |
| Surfaces | card fills, soft bands, dark product surfaces |
| Lines | hairline, border alpha |
| Focus | outline vs ring, color, width, offset, alpha |
| Type families | display, body, mono, and the named substitutes for licensed fonts |
| Type scale | size, weight, line height, tracking per token |
| Radius scale | every value and what it applies to |
| Elevation | each shadow tier, verbatim |
| Control heights | button, input, icon-button heights and padding |
| Hard rules | every "don't" and "never" |

If the spec can't be read, ask for it. Never guess its contents.

## 2. Map Tokens to Theme Roles

- Map each spec role to the theme's existing role (canvas → background, ink → foreground, CTA → primary, soft band → muted, hairline → border, focus → ring, error → destructive). A spec token with no slot gets its own variable in both modes, registered with the styling system.
- Keep the spec's notation (hex stays hex). Copy multi-layer shadows verbatim.
- Pin each radius step to the class the components actually use; grep the component source for `rounded-*` rather than assuming a multiplier fits.
- Turn each type token into one utility carrying family, size, weight, line height, and tracking. In Tailwind, name them `type-*`: `tailwind-merge` reads unknown `text-*` classes as colors and drops one when it sits next to `text-muted-foreground`. Clamp display sizes for mobile and convert pixel tracking to `em` so the ratio holds as size shrinks.
- Fonts: licensed brand fonts get the substitutes the spec names, installed through the project's package manager, with every referenced face imported.
- Dark mode: use the spec's dark surfaces when it defines them. When it's light-only, derive dark from the brand's known dark surfaces and say it's derived.

## 3. Map Component Recipes to Variants

Restyle by editing variants in the component source; keep existing variant names so call sites stay standard. Add a variant only when the spec defines a distinct recipe.

- **Control heights move together.** Changing the button height means changing every field control (input, select, combobox, toggle, tabs, OTP slots) to match, or forms misalign. Grep for the current height class before editing.
- **States follow the spec exactly.** "Darkens on press only" means an `active:` style, not `hover:`. Keep hover on ghost buttons and menu items even when the spec omits it, and say so.
- **Hard rules become checks.** Turn each "don't" into a check run before finishing: no radius off the scale, no accent on buttons, no bold display type.

## 4. Prove It With a Design System Page

Order: foundations, then components, then compositions.

- **Color roles as pairs**: each surface rendered with its foreground ("Aa"), token names, resolved value, and measured contrast. Report any body-text pair under 4.5:1 even when the spec mandates it. The raw palette comes second.
- **Type specimen**: one row per token (token, spec, use, real copy), then a running paragraph at body size with a link and inline code so line length and rhythm show.
- **Radius and elevation ladders** naming the components that use each step.
- **Lead each component with its typical case** in real content, then variants in priority order, then sizes, icons, states.
- **Pin states for review**: render hover, focus, pressed, disabled, loading, and invalid side by side without interaction, using a `data-preview` attribute that the hover/focus/active variants also match. Never put the state name inside the component.
- **Don't render every combination.** Primitives get a variant × state matrix; composed components get a typical example plus one addition at a time. Exhaustive combinations belong in tests.
- **Edge cases beside the component they stress**: long text, empty, error, loading, many items, missing image, disabled, RTL. [stress-test](../workflows/stress-test.md) automates the worst-case pass.
- **Do/Don't pairs** for the two to four spec rules easiest to break, each captioned with the rule in one line.
- **Recipes are acceptance tests.** Rebuild each named spec component, plus one realistic screen, from tokens and components only. A recipe that needs a raw value means the token mapping is incomplete.
- Real content in the brand's voice, no lorem ipsum. Page-level theme toggle, plus a scoped dark band if the spec has dark surfaces.
