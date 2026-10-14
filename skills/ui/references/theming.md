# Theming and Tokens

How UI work stays inside a project's design system: where values live, how components consume them, and how to change them. For applying a brand spec or building a design system page, see [design-system.md](design-system.md).

## Find the System First

Before choosing a style, locate:

- **Token definitions**: CSS variables (`:root` / `.dark`), Tailwind `@theme` blocks, a theme object, or token config. In shadcn projects this is `tailwindCssFile` from `shadcn info --json`.
- **Mode mechanism**: class (`.dark`), attribute, or media query, and who owns the switch.
- **Shared components**: the project's wrappers around its primitive library, their variants, and their state selectors.
- **A nearby example** of the UI being requested.

Read actual declarations before using an unfamiliar token name. After deliberate local customization, the app's live definitions win over any reference snapshot, spec, or library default.

## Define Once, Reference Everywhere

- Literal values (hex, px, ms, shadow geometry) live only in token definitions. Components and screens consume named references.
- Keep both modes together in the definition; never patch one mode at a use site with `dark:` color overrides.
- A computed value copied into source (`15.29px` standing in for a spacing token) is a hardcoded override: it stops tracking the theme.
- Typography is a bundle: font role, weight, size, line height, letter spacing. Apply the matching set; never pick a size and invent a line height.
- Structural choices are application decisions, not tokens: grid tracks, breakpoints, content max-widths, aspect ratios, positioning.
- A utility class or app alias is fine when it resolves to the theme. Trace it before replacing it. Don't add a parallel palette or aliases that hide arbitrary values.

## Color by Role, Not Palette

Use semantic roles paired with their foreground: `bg-primary text-primary-foreground`, `bg-muted text-muted-foreground`, `text-destructive`. A raw palette class (`bg-blue-500`, `text-emerald-600`) bypasses the theme and breaks in the other mode. Status (success, warning, error) uses the theme's status roles or a component variant. A categorical chart series is not a status just because its hue resembles one. Building ramps, naming tokens, and measuring contrast: [color](color/index.md).

## Use the Existing Vocabulary

Finish a screen with the colors, text steps, spacing steps, radii, shadows, and motion values the theme already has. When nothing fits, name the gap rather than inventing a value. For a single element, prefer another existing token or a component variant. Change a shared token only when the user asks for a theme change, then state the affected scope: one token edit reaches every consumer.

## Customizing a Component Library

Component libraries (shadcn/ui, Radix, Base UI, React Aria, MUI) are themed at the source, not at each call site:

1. **Theme variables** for color, radius, shadow, and font.
2. **Built-in variants and sizes** (`variant="outline"`, `size="sm"`).
3. **A new variant** in the component source (`cva`) when the design has a distinct recipe.
4. **A wrapper component** for a recurring composition.

Call-site `className` handles layout (width, grid placement, margins), not color or typography. Unchanged library defaults are not an intentional design decision; a library in default state means the theme was never applied.

Keep the primitive's anatomy, accessibility behavior, refs, form participation, and supported state selectors. Replacing the primitive library is a separate migration, never a prerequisite for theming. Don't assume matching variable names produce the same look across libraries; dimensions, state treatments, and edges may need explicit adaptation.

## Portals Carry the Theme

A portal rendered outside the themed DOM subtree does not inherit its CSS variables. React context does not supply DOM inheritance. Use the app's portal/theme container, or apply the active-mode variables to the portal root, so popovers, menus, toasts, and dialogs keep the font, colors, and mode. Overlay components own their stacking; leave their `z-index` alone.

## States Are Distinct

Map hover, focus-visible, pressed, selected, checked, disabled, read-only, invalid, loading, and complete separately. They are not interchangeable opacity treatments. Keep a real keyboard focus indicator alongside any selected or pressed style. Validation uses `aria-invalid` on the control (shadcn adds `data-invalid` on the `Field`).

## Motion Tokens

Use the theme's duration and easing tokens; controls and small popovers use the short curve, dialogs/drawers/sheets the long one. Honor `prefers-reduced-motion`, and keep the primitive's mount and exit lifecycle rather than adding a competing unmount timer. Choosing curves, durations, and springs: [motion](motion/index.md).

## Mode Edges the Theme Doesn't Reach

- Native `<select>` gets an explicit `background-color` and `color`; Windows dark mode renders broken defaults.
- An SVG favicon with a `<style>` block answering `prefers-color-scheme` stays visible on dark and light browser chrome.
- Locale and mode values that differ between server and client cause hydration mismatches. A React input with `value` needs `onChange` (otherwise use `defaultValue`); in Solid, bind `value` and update through `onInput`. Language comes from `Accept-Language` / `navigator.languages` (never IP geolocation), and auth redirects happen on the server so the URL never flashes.

## Troubleshooting

| Symptom | First checks |
| --- | --- |
| Theme missing on a screen | Tokens defined and loaded in the active scope |
| Popup has a different font or mode | The portal container's variable scope and mode class |
| Theme edits don't reach components | Competing scopes, hardcoded values, stale aliases |
| One change restyles many controls | The shared token or component rule and its consumers |
| Custom `text-*` size class vanishes next to a color | `tailwind-merge` treats unknown `text-*` as a color; name type utilities `type-*` |
| Font looks wrong | Font files cover the used weights; loader's family variable reaches the theme role |
| Layout shifts when a border appears | Reserve the edge (transparent border or inset shadow) in every state |
