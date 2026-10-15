# Web

How the skill's rules are built in browsers: HTML, CSS, ARIA, and a JS UI framework. Read this after [SKILL.md](../../SKILL.md) for any web project, then the domain references with their web files below.

## Framework

Code examples across the web files are React. Check `package.json`:

- `react`: examples apply as written. Component API design (compound components, explicit variants over boolean props, children over render props, state through context) follows the `composition-patterns` skill.
- `solid-js`: read [solid.md](solid.md) before writing code. It maps every React idiom (components, `className`, refs and effects, AnimatePresence and `motion/react`, re-render advice, optimistic state, portals, the composition rules) to Solid 2.

## Stack

- **CSS**: Tailwind defaults; extend through theme tokens, sparingly. Prefer tokens over arbitrary values (`w-[347px]`); an arbitrary value is a structural decision (grid track, max-width) or a gap to name.
- **Class logic**: `cn` (clsx + tailwind-merge). Name custom type utilities `type-*`; tailwind-merge treats unknown `text-*` as colors.
- **Primitives**: one system per project, never mixed. React: Radix, Base UI, or React Aria. Solid: the project's primitive package (e.g. `@bible/ui`, Base UI ported to Solid 2).
- **shadcn/ui** (React): in a project with `components.json`, the `shadcn` skill owns component APIs, composition, and CLI. Customize through theme variables and `cva` variants; call-site `className` is for layout. A library left in default styling means the theme was never applied.
- **Components**: before hand-rolling any component (toast, command menu, OTP input, chart, empty state), use what the project has. React: defer to the `shadcn` skill, installed components first, then `shadcn search` across registries. Solid: the project's primitive package first; [solid.md](solid.md) covers what to do when it lacks one.
- **Animation**: CSS transitions first. Then `motion/react` (React) or WAAPI / Motion's `animate()` (Solid) when a gesture, layout animation, or spring needs it. → [motion](../../references/motion/index.md)
- **Icons**: the project's icon library; `currentColor`; icon-only buttons need an accessible name. → [icons](../../references/icons.md)

### Data Attributes for Conditional Styles

Style state through data attributes rather than `cn` object syntax: a base style plus an attribute override is order-independent.

```tsx
// order-dependent, verbose
<div className={cn({ 'bg-blue-500': !isActive, 'bg-red-500': isActive })} />

// base style + conditional override
<div className="bg-blue-500 data-[active]:bg-red-500" data-active={isActive ? '' : undefined} />
```

In Solid, `data-active={active()}` does the same, since `false` removes the attribute; that is also why boolean `aria-*` attributes need `"true"`/`"false"` strings ([solid.md](solid.md#3-classes-attributes-styling)).

`group-data-*` matches every descendant; give nested groups distinct attribute names when children share the parent's states.

### Z-Index Scale

Fixed tiers for app chrome: `z-0` base, `z-10` raised (cards, dropdown anchors), `z-20` sticky headers. Overlay components (dialog, popover, tooltip, toast) own their stacking; leave their `z-index` alone.

## Web References

| File | Read when |
| --- | --- |
| [Solid](solid.md) | Any code in a Solid project |
| [Mobile web](mobile.md) | Making a web app feel native on phones: hover latching, tap highlight, viewport height, input zoom, safe areas |
| [Sonner](sonner.md) | React toasts once shadcn has installed Sonner; exact props in [sonner-api.md](sonner-api.md) |
| [Creative patterns](creative-patterns.md) | Exploratory UI: navigation, layout, cards, scroll, galleries, micro-interactions |

## Verify

Render in a browser at mobile and desktop widths, in each color mode, at 200% zoom, and with portalled surfaces open. Check the keyboard path and a screen reader (VoiceOver on macOS) on anything interactive.
