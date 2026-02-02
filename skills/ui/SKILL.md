---
name: ui
description: Build accessible, performant, distinctive UIs. Use when implementing web interfaces, components, or reviewing UI code.
allowed-tools: Read, Grep, Glob, Edit, Write
---

# UI Skill

## How to use

- `/ui` – Apply constraints to UI work in this conversation
- `/ui <file>` – Review file against constraints; output:
  - Violation (exact line/snippet)
  - Why it matters (1 sentence)
  - Concrete fix (code-level)

---

## Philosophy

- **Taste over defaults** – Every choice intentional; no auto-pilot
- **Avoid AI slop** – No Inter/Roboto/Arial, no purple-on-white gradients, no cookie-cutter layouts
- **Context-appropriate** – Match aesthetic to purpose/audience; no one-size-fits-all
- **Bold direction** – Commit to an extreme (brutalist, maximalist, minimal, editorial, etc.) and execute with precision

---

## Stack

- **CSS**: Tailwind defaults; extend sparingly
- **Class logic**: `cn` utility (clsx + tailwind-merge)
- **Animation**: `motion/react` for JS-driven; CSS for simple transitions
- **Primitives**: Radix / Base UI / React Aria – never mix systems
- **Icons**: Lucide, Heroicons, or project-specific; icon-only buttons need `aria-label`

---

## Interactions

### Keyboard

- **MUST**: Full keyboard support per [WAI-ARIA APG](https://www.w3.org/WAI/ARIA/apg/patterns/)
- **MUST**: Visible focus rings (`:focus-visible`); group with `:focus-within`
- **MUST**: Manage focus (trap, move, return) per APG patterns
- **MUST**: Focusable elements in sequential lists navigable with ↑↓ arrow keys
- **SHOULD**: Sequential list items deletable with ⌘/Ctrl+Backspace

### Targets & Input

- **MUST**: Hit target ≥24px (mobile ≥44px); expand hit area if visual <24px
- **MUST**: Mobile `<input>` font-size ≥16px (prevents iOS zoom)
- **MUST**: `touch-action: manipulation` to prevent double-tap zoom
- **NEVER**: Disable browser zoom

### Forms

- **MUST**: Input prefix/suffix icons absolutely positioned with padding; clicking them focuses input
- **MUST**: Hydration-safe inputs (no lost focus/value)
- **MUST**: Loading buttons show spinner + keep original label
- **MUST**: Enter submits text input; ⌘/Ctrl+Enter submits `<textarea>`
- **MUST**: Keep submit enabled until request starts; then disable + spinner + idempotency key
- **MUST**: Accept free text and validate after; allow submitting incomplete forms
- **MUST**: Errors inline next to fields; on submit, focus first error
- **MUST**: `autocomplete` + meaningful `name`; correct `type` and `inputmode`
- **MUST**: Warn on unsaved changes before navigation
- **MUST**: Compatible with password managers & 2FA; allow pasting one-time codes
- **MUST**: Trim values; handle trailing spaces
- **MUST**: No dead zones on checkboxes/radios; label+control share one hit target
- **SHOULD**: Disable spellcheck for emails/codes/usernames
- **SHOULD**: Placeholders show example pattern (e.g., `+1 (123) 456-7890`)
- **NEVER**: Block paste in `<input>/<textarea>`

### State & Navigation

- **MUST**: URL reflects state (filters/tabs/pagination). Prefer [nuqs](https://nuqs.dev)
- **MUST**: Back/Forward restores scroll
- **MUST**: Links use `<a>/<Link>`; Cmd/Ctrl/middle-click works
- **MUST**: `AlertDialog` for destructive actions; or provide Undo window

### Feedback

- **MUST**: Toggles take effect immediately; no confirmation
- **MUST**: Polite `aria-live` for toasts/inline validation
- **SHOULD**: Optimistic UI; reconcile on response; rollback + error on failure
- **SHOULD**: Ellipsis (`…`) for options opening follow-ups ("Rename…") and loading ("Saving…")
- **SHOULD**: Display feedback relative to trigger (inline checkmark, not toast)

### Touch/Drag/Scroll

- **MUST**: Generous targets; clear affordances
- **MUST**: Delay first tooltip in group; subsequent peers no delay
- **MUST**: `overscroll-behavior: contain` in modals/drawers
- **MUST**: During drag: disable text selection; `inert` on dragged elements
- **MUST**: Interactive elements disable `user-select` for inner content
- **MUST**: Decorative elements disable `pointer-events`
- **MUST**: Hover states use `@media (hover: hover)` to avoid flash on touch
- **MUST**: `muted` + `playsinline` on `<video>` for iOS auto-play
- **MUST**: Disable native `touch-action` for custom pan/zoom gestures
- **MUST**: Replace iOS tap highlight (`-webkit-tap-highlight-color: transparent`) with appropriate alternative
- **MUST**: Nested menus use prediction cone to prevent accidental closure

### Autofocus

- **SHOULD**: Autofocus on desktop with single primary input; rarely on mobile (avoids layout shift)

---

## Animation

### Core Rules

- **NEVER**: Add animation unless explicitly requested or it clarifies cause/effect
- **MUST**: Honor `prefers-reduced-motion` (provide reduced variant)
- **MUST**: Animations interruptible and input-driven (avoid autoplay)
- **MUST**: Correct `transform-origin` (motion starts where it "physically" should)
- **MUST**: Theme switching should not trigger transitions
- **MUST**: Looping animations pause when off-screen
- **SHOULD**: Duration ≤200ms for interactions to feel immediate
- **SHOULD**: Animation values proportional to trigger size (scale from ~0.96, not 0→1)
- **SHOULD**: Frequent/low-novelty actions avoid extraneous animations
- **SHOULD**: `scroll-behavior: smooth` for in-page anchors with appropriate offset

### Performance Tiers

| Tier | Properties | Notes |
|------|------------|-------|
| S | `transform`, `opacity` | Compositor-only; no layout/paint |
| A | `filter`, `clip-path` | Compositor with caveats |
| B | `background-color`, `box-shadow` | Paint only; no layout |
| F | `width`, `height`, `top`, `left`, `padding`, `margin` | Triggers layout; avoid |

- **MUST**: Animate only S/A tier props; avoid F tier
- **SHOULD**: Use `motion/react` over manual CSS for complex animations (auto-optimizes)
- **NEVER**: Animate large blur/backdrop surfaces
- **NEVER**: Use `will-change` outside active animations

---

## Layout

- **MUST**: Use `h-dvh` (not `h-screen`) for full-height layouts
- **MUST**: Respect safe areas (`env(safe-area-inset-*)`)
- **MUST**: Avoid unwanted scrollbars; fix overflows
- **MUST**: Deliberate alignment to grid/baseline/edges
- **MUST**: Verify mobile, laptop, ultra-wide (simulate at 50% zoom)
- **MUST**: Use `size-*` for square elements (not `w-* h-*`)
- **SHOULD**: Optical alignment; ±1px when perception beats geometry
- **SHOULD**: Balance icon/text lockups (stroke/weight/size/spacing/color)
- **NEVER**: Use arbitrary Tailwind values (`w-[347px]`); prefer design tokens

### Z-Index Scale

Use fixed scale; no arbitrary values:

```
z-0    base
z-10   raised (cards, dropdowns)
z-20   sticky headers
z-30   overlays/backdrops
z-40   modals/dialogs
z-50   tooltips/popovers
```

---

## Typography

- **MUST**: `text-balance` for headings; `text-pretty` for body
- **MUST**: `tabular-nums` for data/comparisons
- **MUST**: Font weight should not change on hover/selected (prevents layout shift)
- **MUST**: `-webkit-text-size-adjust: 100%` to prevent iOS landscape resizing
- **MUST**: Use ellipsis character `…` (not `...`)
- **MUST**: Non-breaking spaces: `10&nbsp;MB`, `⌘&nbsp;+&nbsp;K`
- **SHOULD**: `-webkit-font-smoothing: antialiased`
- **SHOULD**: `text-rendering: optimizeLegibility`
- **SHOULD**: Subset fonts; avoid weights below 400
- **SHOULD**: Medium headings: font weight 500-600
- **SHOULD**: CSS `clamp()` for fluid sizing
- **SHOULD**: Curly quotes (" "); avoid widows/orphans

---

## Content & Accessibility

- **MUST**: `<title>` matches current context
- **MUST**: Skeletons mirror final content (avoid CLS)
- **MUST**: Design empty/sparse/dense/error states
- **MUST**: No dead ends; always offer next step/recovery
- **MUST**: Empty states must offer one clear action
- **MUST**: Redundant status cues (not color-only); icons have text labels
- **MUST**: `scroll-margin-top` on headings; "Skip to content" link; hierarchical `<h1–h6>`
- **MUST**: Resilient to user-generated content (short/avg/very long)
- **MUST**: Locale-aware dates/times/numbers/currency
- **MUST**: Accurate `aria-label`; decorative elements `aria-hidden`
- **MUST**: Prefer native semantics (`button`, `a`, `label`, `table`) before ARIA
- **MUST**: Images use `<img>` (screen readers, right-click copy)
- **MUST**: HTML illustrations have explicit `aria-label`
- **MUST**: Gradient text unset gradient on `::selection`
- **SHOULD**: Inline help first; tooltips last resort
- **SHOULD**: Tooltips triggered by hover should not contain interactive content
- **SHOULD**: SVG favicon with `<style>` for `prefers-color-scheme`
- **NEVER**: Disabled buttons with tooltips (not in tab order)

---

## Performance

- **MUST**: Track and minimize re-renders (React DevTools/React Scan)
- **MUST**: Profile with CPU/network throttling
- **MUST**: Batch layout reads/writes; avoid unnecessary reflows
- **MUST**: Mutations (`POST/PATCH/DELETE`) target <500ms
- **MUST**: Virtualize large lists (e.g., `virtua`)
- **MUST**: Preload only above-the-fold images; lazy-load the rest
- **MUST**: Prevent CLS from images (explicit dimensions or reserved space)
- **MUST**: On iOS, limit auto-playing videos; pause/unmount off-screen videos
- **SHOULD**: Test iOS Low Power Mode and macOS Safari
- **SHOULD**: Measure without extensions that skew runtime
- **SHOULD**: Prefer uncontrolled inputs; make controlled loops cheap
- **SHOULD**: Bypass React render cycle with refs for real-time DOM commits
- **SHOULD**: Detect and adapt to hardware/network capabilities ([react-adaptive-hooks](https://github.com/GoogleChromeLabs/react-adaptive-hooks))
- **NEVER**: Large `blur()` values on `filter`/`backdrop-filter`
- **NEVER**: Scale/blur filled rectangles (causes banding); use radial gradients

---

## Design

- **MUST**: Meet contrast – prefer [APCA](https://apcacontrast.com/) over WCAG 2
- **MUST**: Increase contrast on `:hover/:active/:focus`
- **MUST**: Accessible charts (color-blind-friendly palettes)
- **MUST**: Auth redirects happen server-side (no URL jank)
- **SHOULD**: Layered shadows (ambient + direct)
- **SHOULD**: Crisp edges via semi-transparent borders + shadows
- **SHOULD**: Nested radii: child ≤ parent; concentric
- **SHOULD**: Hue consistency: tint borders/shadows/text toward bg hue
- **SHOULD**: Match browser UI to page background
- **SHOULD**: Avoid gradient banding (use masks when needed)
- **SHOULD**: Style `::selection`
- **NEVER**: Add gratuitous gradients; use only when purposeful

---

## Reference

Distilled from:
- [Vercel Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines)
- [raunofreiberg/interfaces](https://github.com/raunofreiberg/interfaces)
- [ui-skills.com](https://ui-skills.com)
