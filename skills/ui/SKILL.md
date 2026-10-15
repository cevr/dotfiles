---
name: ui
description: Build, review, and polish user interfaces in any stack — web (React, Solid), Apple (SwiftUI, UIKit, AppKit), Android (Compose), or anything else that draws a UI. Use for any UI work — new screens, components, theming and design tokens, design systems from a spec, motion and animation, accessibility, typography, color, layout, interface copy — and for reviewing UI code, building from Figma or a design image, stress-testing a component with worst-case data, rendering every state, exploring variants, or explaining how an interface or effect was built.
---

# UI

One skill for interface work in any stack. `references/` holds what is true everywhere: judgment, values, and rules per domain, with short platform-specific notes labelled inline (**Web:**). `platforms/` holds the longer implementation material per platform. Read this file, then the platform index, then only the references the task reaches.

## Platform

Identify the platform first and read its index:

| Project has | Platform | Read |
| --- | --- | --- |
| `package.json` with a UI framework (React, Solid) | Web | [web](platforms/web/index.md) |
| An Xcode project or `Package.swift` with SwiftUI, UIKit, or AppKit | Apple | [apple](platforms/apple/index.md) |
| `build.gradle(.kts)` with Compose or Android views | Android | [android](platforms/android/index.md) |
| Anything else (Flutter, Qt, GTK, a terminal UI, a game UI) | Other | No index: apply the references directly, and translate their labelled web notes through the platform file closest to the stack. The platform's own guidelines take the platform-convention slot in [precedence](#precedence). |

A domain reference states the rule and its values; the platform's file for that domain (`platforms/<platform>/<domain>.md`, listed in its index) gives the APIs and code. Sizes are in points: CSS `px`, Apple `pt`, Android `dp`. Durations are in milliseconds.

## Modes

| Invocation | Does | Read |
| --- | --- | --- |
| `/ui` or any UI task | Build or edit UI under these rules | This file, the platform index, then the references the task touches |
| `/ui review [file\|component\|branch\|PR]` | Cross-discipline review: accessibility, layout, writing, typography, color, surfaces, motion | [workflows/review.md](workflows/review.md) |
| `/ui motion-review [target]` | Strict review of animation code | [workflows/motion-review.md](workflows/motion-review.md) |
| `/ui motion-audit` | Codebase-wide motion audit into prioritized, self-contained plans | [workflows/motion-audit.md](workflows/motion-audit.md) |
| `/ui motion-opportunities` | Find what should animate and what shouldn't | [workflows/motion-opportunities.md](workflows/motion-opportunities.md) |
| `/ui build-design <figma\|image>` | Build UI that matches a design, using project tokens and components | [workflows/build-design.md](workflows/build-design.md) |
| `/ui stress-test <component>` | Render worst-case data and every reachable scenario; report what broke | [workflows/stress-test.md](workflows/stress-test.md) |
| `/ui states <component>` | Render every state side by side or behind a switcher | [workflows/states.md](workflows/states.md) |
| `/ui variants <component>` | Build several genuinely different versions and pick one | [workflows/variants.md](workflows/variants.md) |
| `/ui explain <url\|image\|recording\|app>` | Explain how an interface, effect, or animation was built | [workflows/explain.md](workflows/explain.md) |

## Precedence

1. **The project's system wins.** A `GUI.md`, `DESIGN.md`, brand spec, or established theme and component library decides values; the Graphical skills own projects with a `GUI.md`. Match the project's fonts, tokens, density, and motion language. A deliberate, consistent project convention is a preference, not a finding.
2. **Platform conventions** come next where they define a control, a pattern, or a value: Apple's Human Interface Guidelines, Material 3 on Android, browser conventions on the web. A native app that ignores them feels foreign. Each platform file says where its convention replaces a domain value.
3. **Domain references** decide where the project and platform are silent: exact values for motion, surfaces, type, color, layout, accessibility, copy.
4. **Aesthetic direction** below applies only when choosing a new direction with no system to follow.

Accessibility requirements outrank polish everywhere: a polish finding never outranks a broken interaction.

## Before Building

- Locate the theme, mode mechanism, shared components, and a nearby example before choosing any style. Finish with the existing vocabulary; name a gap instead of inventing a value. → [theming](references/theming.md)
- Build the smallest complete interface: a clear title, useful content, the needed actions. Every eyebrow, subtitle, badge, and helper line must carry information or enable an action. → [interface judgment](references/interface-judgment.md)
- Use existing components before building one: the project's own, then the platform's system controls or component library. Hand-rolling a menu, sheet, or toast is how focus, dismissal, and announcements break.

## Aesthetic Direction

When there is no system to follow and the task is to choose one:

- **Commit to a direction** that fits the audience (editorial, minimal, brutalist, dense tool) and execute it precisely. Every choice deliberate.
- **Type**: on the web, pick a face for the direction rather than defaulting to Inter, Roboto, or Arial; candidates include Geist, Outfit, Satoshi, Cabinet Grotesk, General Sans, Plus Jakarta Sans. On Apple and Android the system face is the default and a custom face is a brand decision. Serif belongs to editorial and marketing, not dashboards. In an existing project, never propose a new typeface unless asked.
- **Color**: one accent per surface, saturation under 80%, one temperature (warm or cool) across accents. Avoid the generic AI palette: violet `#7C3AED` and its neighbors, neon gradients, rainbow accent sets. Gradients only when they carry meaning.
- **Layout**: high-variance content (dashboards, feeds, tools) gets no centered hero. Replace rows of three equal cards with asymmetric, split, or bento arrangements; break symmetry on purpose.
- **Content realism**: real-sounding names and organic numbers, never John Doe, Acme Corp, $99.99, or 99.9% uptime. No filler verbs (Elevate, Seamless, Unleash, Supercharge, Empower, Cutting-edge). Placeholder images from `picsum.photos` or generated shapes, never `source.unsplash.com`. No emoji in UI unless the design calls for it.

## Reference

| Domain | Read when |
| --- | --- |
| [Interface judgment](references/interface-judgment.md) | Composing any screen: design principles, hierarchy, copy that earns its place, where each fact lives; designing a reusable component |
| [Theming](references/theming.md) | Any styling in a project with tokens, a theme, or a component library; overlays; state treatments |
| [Design system](references/design-system.md) | Applying a brand spec or `DESIGN.md`; building a design system page |
| [Motion](references/motion/index.md) | Whether and how to animate: purpose, easing, duration, springs, pattern values, enter/exit, reduced motion |
| [Motion standards](references/motion/standards.md) | The craft bar motion is reviewed against |
| [Motion performance](references/motion/performance.md) | Jank, dropped frames, what to animate, where animation runs, per-frame values |
| [Gestures and fluid motion](references/motion/gestures.md) | Drag, swipe, sheets, momentum, springs, materials and depth |
| [Motion vocabulary](references/motion/vocabulary.md) | Naming an effect someone describes |
| [Surfaces](references/surfaces.md) | Cards, buttons, containers: concentric radii, optical alignment, shadows vs borders, materials, image outlines |
| [Icons](references/icons.md) | Icon stroke, size, state, RTL |
| [Color](references/color/index.md) | Palettes, ramps, semantic tokens, contrast, dark mode |
| [Typography](references/typography/index.md) | Type scale, spacing, fonts, OpenType, wrapping, punctuation |
| [Layout](references/layout/index.md) | Grouping, alignment, reading order, adaptive structure, RTL, translation room |
| [Accessibility](references/accessibility/index.md) | Keyboard, focus, semantics, forms, screen readers, hit areas, motion and text size |
| [Writing](references/writing/index.md) | Labels, buttons, errors, empty states, confirmations, voice |

## Verify

Report separately what was type-checked, what was exercised in tests, and what was seen rendered. Source inspection cannot establish rendered contrast, motion feel, or visual fidelity: render the change in each mode and state it touches, at compact and regular widths, at the largest text size, and including overlays. The platform index names how to render and what to check there. Say which checks you could not run.

---

Merged from Emil Kowalski's [skills](https://github.com/emilkowalski/skills) and Jakub Krehel's [skills](https://github.com/jakubkrehel/skills) (both MIT), the shadcn/ui skill's design guidance, Graphical's GUI guide, [Vercel's Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines), [Butterick's Practical Typography](https://practicaltypography.com/), [raunofreiberg/interfaces](https://github.com/raunofreiberg/interfaces), and [ui-skills.com](https://ui-skills.com).
