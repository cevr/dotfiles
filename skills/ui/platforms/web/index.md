# Web

How the skill's rules are built in browsers: HTML, CSS, ARIA, and a JS UI framework. Read this after [SKILL.md](../../SKILL.md) for any web project, then the domain references with their web files below.

## Framework

Code examples across the web files are React. Check `package.json`:

- `react`: examples apply as written. Component API design (compound components, explicit variants over boolean props, children over render props, state through context) follows the `composition-patterns` skill.
- `solid-js`: read [solid.md](solid.md) before writing code. It maps every React idiom (components, `className`, refs and effects, AnimatePresence and `motion/react`, re-render advice, optimistic state, portals, the composition rules) to Solid 2.

## Stack

- **Styling**: Tailwind defaults, extended through theme tokens; classes, `cn`, `cva`, state attributes, and z-index in [web theming](theming.md).
- **Primitives**: one system per project, never mixed. React: Radix, Base UI, or React Aria. Solid: the project's primitive package (e.g. `@bible/ui`, Base UI ported to Solid 2).
- **Components**: before hand-rolling any component (toast, command menu, OTP input, chart, empty state), use what the project has. React: the `shadcn` skill owns component APIs, composition, and the CLI in a project with `components.json`; installed components first, then `shadcn search` across registries. Solid: the project's primitive package first; [solid.md](solid.md) covers what to do when it lacks one.
- **Animation**: CSS transitions first. Then `motion/react` (React) or WAAPI / Motion's `animate()` (Solid) when a gesture, layout animation, or spring needs it. → [motion](../../references/motion/index.md), [web motion](motion.md#tools)
- **Icons**: the project's icon library; `currentColor`; icon-only buttons need an accessible name. → [icons](../../references/icons.md)

## Web References

| File | Read when |
| --- | --- |
| [Solid](solid.md) | Any code in a Solid project |
| [Theming](theming.md) | Tokens, Tailwind classes, `cn`/`cva`, shadcn customization, state attributes, portals, z-index, mode edges, design-system page |
| [Motion](motion.md) | Tool choice (CSS, WAAPI, Motion), easing tokens, Motion springs, `@starting-style`, `clip-path`, hover and reduced-motion gating, gesture code, web review rows |
| [Motion recipes](motion-recipes.md) | CSS and React code for each motion pattern: press, popover, tooltip, modal, drawer, toast, accordion, stagger, exits, icon cross-fade, hold-to-confirm, tab indicator, scroll reveal, theme switch |
| [Motion performance](motion-performance.md) | Browser jank: rendering pipeline, compositor thread, CSS-variable traps, `will-change`, per-frame renders |
| [Surfaces](surfaces.md) | Concentric radii, optical nudges, shadow rings, image outlines in CSS and Tailwind |
| [Icons](icons.md) | SVG stroke, `currentColor` state colors, variants, RTL flips |
| [Color](color.md) | CSS notations and conversion, P3 via `@media (color-gamut)`, `color-mix()`/relative color/`light-dark()`, tokens in `:root` and Tailwind `@theme`, dark-mode and `prefers-contrast` switching, gradient interpolation |
| [Typography](typography.md) | CSS for the typography rules: units, scale custom properties, fonts and synthesis, properties over raw tags, `text-box`, underlines, selection, iOS input zoom, decorative text |
| [Typography CSS cheat sheet](typography-css.md) | Translating any typography declaration to its Tailwind 4 utility, or back |
| [Layout](layout.md) | CSS for grouping, logical properties, peeking scrollers, safe areas, container queries, growth and clipping |
| [Accessibility](accessibility.md) | Focus rings, skip link, tabindex, dialogs, form markup and autocomplete tokens, `sr-only`, live regions, SVG, hit-area CSS, reduced-motion CSS, zoom; the before-you-finish checklist |
| [Semantics and ARIA](semantics-and-aria.md) | Element choice (button vs link vs div), the rules of ARIA, landmarks, accessible-name precedence, common ARIA mistakes, disabled vs `aria-disabled` |
| [Writing](writing.md) | ICU plurals, `Intl` formatting, copy detection greps |
| [Mobile web](mobile.md) | Making a web app feel native on phones: hover latching, tap highlight, viewport height, input zoom, safe areas |
| [Sonner](sonner.md) | React toasts once shadcn has installed Sonner; exact props in [sonner-api.md](sonner-api.md) |
| [Creative patterns](creative-patterns.md) | Exploratory UI: navigation, layout, cards, scroll, galleries, micro-interactions |

## Verify

Render in a browser at mobile and desktop widths, in each color mode, at 200% zoom, and with portalled surfaces open. Check the keyboard path and a screen reader (VoiceOver on macOS) on anything interactive. Capture commands and preview harnesses: [harness](../../workflows/harness.md#looking-at-it).
