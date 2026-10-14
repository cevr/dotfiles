---
name: ui
description: Build, review, and polish web interfaces. Use for any frontend UI work — new screens, components, theming and design tokens, design systems from a spec, motion and animation, accessibility, typography, color, layout, interface copy, mobile web — and for reviewing UI code, building from Figma or a design image, stress-testing a component with worst-case data, rendering every state, exploring variants, or explaining how a site or effect was built.
---

# UI

One skill for interface work. This file holds the conventions every task needs and routes to the domain references and workflows; read only what the task reaches.

## Modes

| Invocation | Does | Read |
| --- | --- | --- |
| `/ui` or any UI task | Build or edit UI under these rules | This file, then the references the task touches |
| `/ui review [file\|component\|branch\|PR]` | Cross-discipline review: accessibility, layout, writing, typography, color, surfaces, motion | [workflows/review.md](workflows/review.md) |
| `/ui motion-review [target]` | Strict review of animation code | [workflows/motion-review.md](workflows/motion-review.md) |
| `/ui motion-audit` | Codebase-wide motion audit into prioritized, self-contained plans | [workflows/motion-audit.md](workflows/motion-audit.md) |
| `/ui motion-opportunities` | Find what should animate and what shouldn't | [workflows/motion-opportunities.md](workflows/motion-opportunities.md) |
| `/ui build-design <figma\|image>` | Build UI that matches a design, using project tokens and components | [workflows/build-design.md](workflows/build-design.md) |
| `/ui stress-test <component>` | Render worst-case data and every reachable scenario; report what broke | [workflows/stress-test.md](workflows/stress-test.md) |
| `/ui states <component>` | Render every state on a throwaway page with a switcher | [workflows/states.md](workflows/states.md) |
| `/ui variants <component>` | Build several genuinely different versions and pick one | [workflows/variants.md](workflows/variants.md) |
| `/ui explain <url\|image>` | Explain how a site, effect, or animation was built | [workflows/explain.md](workflows/explain.md) |

## Precedence

1. **The project's system wins.** A `GUI.md`, `DESIGN.md`, brand spec, or established theme and component library decides values; the Graphical skills own projects with a `GUI.md`. Match the project's fonts, tokens, density, and motion language. A deliberate, consistent project convention is a preference, not a finding.
2. **Domain references** decide where the project is silent: exact values for motion, surfaces, type, color, layout, accessibility, copy.
3. **Aesthetic direction** below applies only when choosing a new direction with no system to follow.

Accessibility requirements outrank polish everywhere: a polish finding never outranks a broken interaction.

## Before Building

- Locate the theme, mode mechanism, shared components, and a nearby example before choosing any style. Finish with the existing vocabulary; name a gap instead of inventing a value. → [theming](references/theming.md)
- Build the smallest complete interface: a clear title, useful content, the needed actions. Every eyebrow, subtitle, badge, and helper line must carry information or enable an action. → [interface judgment](references/interface-judgment.md)

## Stack

- **CSS**: Tailwind defaults; extend through theme tokens, sparingly. Prefer tokens over arbitrary values (`w-[347px]`); an arbitrary value is a structural decision (grid track, max-width) or a gap to name.
- **Class logic**: `cn` (clsx + tailwind-merge). Name custom type utilities `type-*`; tailwind-merge treats unknown `text-*` as colors.
- **Primitives**: one system per project — Radix, Base UI, or React Aria. Never mix.
- **shadcn/ui**: in a project with `components.json`, the `shadcn` skill owns component APIs, composition, and CLI. Customize through theme variables and `cva` variants; call-site `className` is for layout. A library left in default styling means the theme was never applied.
- **Animation**: CSS transitions first; `motion/react` when a gesture, layout animation, or spring needs it. → [motion](references/motion/index.md)
- **Icons**: the project's icon library; `currentColor`; icon-only buttons need an accessible name. → [icons](references/icons.md)
- **Components**: before hand-rolling any component (toast, command menu, OTP input, chart, empty state), defer to the `shadcn` skill: the project's installed components first, then `shadcn search` across registries.

### Data Attributes for Conditional Styles

Style state through data attributes rather than `cn` object syntax: a base style plus an attribute override is order-independent.

```tsx
// order-dependent, verbose
<div className={cn({ 'bg-blue-500': !isActive, 'bg-red-500': isActive })} />

// base style + conditional override
<div className="bg-blue-500 data-[active]:bg-red-500" data-active={isActive ? '' : undefined} />
```

`group-data-*` matches every descendant; give nested groups distinct attribute names when children share the parent's states.

### Z-Index Scale

Fixed tiers for app chrome: `z-0` base, `z-10` raised (cards, dropdown anchors), `z-20` sticky headers. Overlay components (dialog, popover, tooltip, toast) own their stacking; leave their `z-index` alone.

## Aesthetic Direction

When there is no system to follow and the task is to choose one:

- **Commit to a direction** that fits the audience (editorial, minimal, brutalist, dense tool) and execute it precisely. Every choice deliberate.
- **Type**: pick a face for the direction rather than defaulting to Inter, Roboto, or Arial; candidates include Geist, Outfit, Satoshi, Cabinet Grotesk, General Sans, Plus Jakarta Sans. Serif belongs to editorial and marketing, not dashboards. In an existing project, never propose a new typeface unless asked.
- **Color**: one accent per surface, saturation under 80%, one temperature (warm or cool) across accents. Avoid the generic AI palette: violet `#7C3AED` and its neighbors, neon gradients, rainbow accent sets. Gradients only when they carry meaning.
- **Layout**: high-variance content (dashboards, feeds, tools) gets no centered hero. Replace rows of three equal cards with asymmetric, split, or bento arrangements; break symmetry on purpose.
- **Content realism**: real-sounding names and organic numbers, never John Doe, Acme Corp, $99.99, or 99.9% uptime. No filler verbs (Elevate, Seamless, Unleash, Supercharge, Empower, Cutting-edge). Placeholders from `picsum.photos` or inline SVG, never `source.unsplash.com`. No emoji in UI unless the design calls for it.

## Reference

| Domain | Read when |
| --- | --- |
| [Interface judgment](references/interface-judgment.md) | Composing any screen: design principles, hierarchy, copy that earns its place, where each fact lives; designing a reusable component |
| [Theming](references/theming.md) | Any styling in a project with tokens, a theme, or a component library; portals; state treatments |
| [Design system](references/design-system.md) | Applying a brand spec or `DESIGN.md`; building a design system page |
| [Motion](references/motion/index.md) | Whether and how to animate: purpose, easing, duration, springs, enter/exit, reduced motion |
| [Motion recipes](references/motion/recipes.md) | Implementing a known pattern: press, popover, toast, stagger, icon swap, drawer |
| [Motion standards](references/motion/standards.md) | The craft bar motion is reviewed against |
| [Motion performance](references/motion/performance.md) | Jank, dropped frames, `will-change`, CSS vs WAAPI vs JS |
| [Gestures and fluid motion](references/motion/gestures.md) | Drag, swipe, sheets, momentum, springs, materials and depth |
| [Motion vocabulary](references/motion/vocabulary.md) | Naming an effect someone describes |
| [Surfaces](references/surfaces.md) | Cards, buttons, containers: concentric radii, optical alignment, shadows vs borders, image outlines |
| [Icons](references/icons.md) | Icon stroke, size, state, RTL |
| [Color](references/color/index.md) | Palettes, ramps, semantic tokens, contrast, dark mode |
| [Typography](references/typography/index.md) | Type scale, spacing, fonts, OpenType, wrapping, punctuation |
| [Layout](references/layout/index.md) | Grouping, alignment, reading order, responsive structure, RTL, translation room |
| [Accessibility](references/accessibility/index.md) | Keyboard, focus, ARIA, forms, screen readers, hit areas, motion and zoom |
| [Writing](references/writing/index.md) | Labels, buttons, errors, empty states, confirmations, voice |
| [Mobile web](references/mobile-web.md) | Making a web app feel native on phones: hover latching, tap highlight, viewport height, input zoom, safe areas |
| [Sonner](references/sonner.md) | Toast API, styling, and troubleshooting once shadcn has installed Sonner; exact props in [sonner-api.md](references/sonner-api.md) |
| [Creative patterns](references/creative-patterns.md) | Exploratory UI: navigation, layout, cards, scroll, galleries, micro-interactions |

## Verify

Report separately what was type-checked, what was exercised in tests, and what was seen rendered. Source inspection cannot establish rendered contrast, motion feel, or visual fidelity; render the change in each mode and state it touches, at mobile and desktop widths, including portalled surfaces. Say which checks you could not run.

---

Merged from Emil Kowalski's [skills](https://github.com/emilkowalski/skills) and Jakub Krehel's [skills](https://github.com/jakubkrehel/skills) (both MIT), the shadcn/ui skill's design guidance, Graphical's GUI guide, [Vercel's Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines), [Butterick's Practical Typography](https://practicaltypography.com/), [raunofreiberg/interfaces](https://github.com/raunofreiberg/interfaces), and [ui-skills.com](https://ui-skills.com).
