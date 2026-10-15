# Theming on the Web

CSS variables, Tailwind, and component-library customization for the rules in [theming](../../references/theming.md), plus the web side of [design systems](../../references/design-system.md). Code is React; in a Solid project, translate it through [solid.md](solid.md).

## Where the System Lives

| Neutral | Web |
| --- | --- |
| [Token definitions](../../references/theming.md#find-the-system-first) | CSS variables on `:root` and `.dark`, Tailwind `@theme` blocks, a theme object, or token config. In a shadcn project, the file at `tailwindCssFile` from `shadcn info --json` (`tailwind.css` in `components.json`); edit that file rather than creating a new one |
| Mode mechanism | A class (`.dark`), an attribute (`data-theme`), or the `prefers-color-scheme` media query; find who toggles it |
| Shared components | The project's wrappers around its primitive library, their `cva` variants, and their state selectors (`data-state`, `data-disabled`) |

## Tokens and Classes

- [Define once](../../references/theming.md#define-once-reference-everywhere): both modes sit together in the variable definitions. A `dark:` color override at a use site is the mode-conditional patch the rule forbids.
- [Color by role](../../references/theming.md#color-by-role-not-palette): `bg-primary text-primary-foreground`, `bg-muted text-muted-foreground`, `text-destructive`. A raw palette class (`bg-blue-500`, `text-emerald-600`) is the bypass.
- A Tailwind utility or app alias that resolves to a CSS variable counts as the theme.
- Class logic goes through `cn` (clsx + tailwind-merge). Name custom type utilities `type-*`: tailwind-merge reads an unknown `text-*` class as a color and drops it when it sits next to `text-muted-foreground`.

## Customizing a Component Library

The [ladder](../../references/theming.md#customizing-a-component-library) for shadcn/ui, Radix, Base UI, React Aria, or MUI:

1. Theme variables for color, radius, shadow, and font.
2. Built-in variants and sizes (`variant="outline"`, `size="sm"`).
3. A new `cva` variant in the component source.
4. A wrapper component.

Call-site `className` handles width, grid placement, and margins. Keep the primitive's refs, form participation, and supported state selectors. In a shadcn project the `shadcn` skill owns component APIs and the CLI.

## Portals Carry CSS Variables

A portal renders outside the themed DOM subtree, so it does not inherit CSS variables declared on a themed ancestor. React context does not supply DOM inheritance. Use the app's portal or theme container, or apply the active mode's class and variables to the portal root, so popovers, menus, toasts, and dialogs keep the font, colors, and mode. Overlay components own their stacking; leave their `z-index` alone.

**Z-index scale** for app chrome: `z-0` base, `z-10` raised (cards, dropdown anchors), `z-20` sticky headers.

## States

- Style focus with `:focus-visible` so the ring shows for keyboard use and stays beside any selected or pressed style.
- Validation: `aria-invalid` on the control; shadcn adds `data-invalid` on the `Field`.
- Reduced motion: `prefers-reduced-motion`. Keep the primitive's mount and exit lifecycle (its `data-state` open/closed and exit animation) rather than adding an unmount `setTimeout`.

### Data Attributes for State Styles

Style state through data attributes rather than `cn` object syntax: a base style plus an attribute override is order-independent.

```tsx
// order-dependent, verbose
<div className={cn({ 'bg-blue-500': !isActive, 'bg-red-500': isActive })} />

// base style + conditional override
<div className="bg-blue-500 data-[active]:bg-red-500" data-active={isActive ? '' : undefined} />
```

In Solid, `data-active={active()}` does the same, since `false` removes the attribute; that is also why boolean `aria-*` attributes need `"true"`/`"false"` strings ([solid.md](solid.md#3-classes-attributes-styling)).

`group-data-*` matches every descendant; give nested groups distinct attribute names when children share the parent's states.

## Mode Edges

The web's [mode edges](../../references/theming.md#mode-edges-the-theme-doesnt-reach):

- **Native `<select>`**: give it an explicit `background-color` and `color`; Windows dark mode renders broken defaults.
- **Favicon**: an SVG favicon with a `<style>` block answering `prefers-color-scheme` stays visible on dark and light browser chrome.
- **Hydration**: locale and mode values that differ between server and client cause hydration mismatches. Language comes from `Accept-Language` / `navigator.languages` (never IP geolocation), and auth redirects happen on the server so the URL never flashes.
- **Controlled inputs**: a React input with `value` needs `onChange` (otherwise use `defaultValue`). In Solid, bind `value` and update through `onInput` ([solid.md](solid.md)).
- **Browser chrome**: the `theme-color` meta tag per mode is in [mobile web](mobile.md).

## Troubleshooting

Web rows beside the [neutral table](../../references/theming.md#troubleshooting):

| Symptom | First checks |
| --- | --- |
| Popup has a different font or mode | The portal container's variable scope and mode class |
| Custom `text-*` size class vanishes next to a color | `tailwind-merge` treats unknown `text-*` as a color; name type utilities `type-*` |
| Font looks wrong | The font loader's family variable (`next/font`'s `variable`, a `@font-face` family) reaches the theme's `--font-*` role |

## Design System

Web specifics for [design systems from a spec](../../references/design-system.md). In a shadcn project, the `shadcn` skill's `design-system.md` runs the whole workflow with its CLI.

| Step | Web |
| --- | --- |
| [Map tokens](../../references/design-system.md#2-map-tokens-to-theme-roles) | A spec token with no slot gets a CSS variable in `:root` and `.dark`, registered in `@theme` |
| Radius steps | Grep the component source for `rounded-*` to find the class each component uses |
| Text styles | One `type-*` utility per type token (family, size, weight, line height, tracking). Clamp display sizes with `clamp()` and write tracking in `em` (pixel tracking ÷ font size) |
| Fonts | Substitutes installed through the project's package manager (`@fontsource/*`, `next/font`), with every referenced face imported |
| [Control heights](../../references/design-system.md#3-map-component-recipes-to-variants) | Grep for the current height class (`h-9`) across field controls before editing |
| Press-only states | "Darkens on press only" is an `active:` style, not `hover:` |
| [Pinned states](../../references/design-system.md#4-prove-it-with-a-design-system-page) | A `data-preview` attribute that the `hover:`, `focus-visible:`, and `active:` variants also match, so each state renders without interaction |
| Mode | A page-level theme toggle, plus a scoped `.dark` band when the spec has dark surfaces |
