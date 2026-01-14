---
name: web-interface
description: Guidelines for building accessible, fast, and delightful web UIs. Use when implementing interactions, forms, animations, layouts, or reviewing UI code quality.
allowed-tools: [Read, Grep, Glob, Edit, Write]
---

# Web Interface Guidelines

Rules for building accessible, fast, delightful UIs. MUST/SHOULD/NEVER guide decisions.

## Interactions

### Keyboard

- **MUST**: Full keyboard support per [WAI-ARIA APG](https://www.w3.org/WAI/ARIA/apg/patterns/)
- **MUST**: Visible focus rings (`:focus-visible`; group with `:focus-within`)
- **MUST**: Manage focus (trap, move, return) per APG patterns

### Targets & Input

- **MUST**: Hit target ≥24px (mobile ≥44px). If visual <24px, expand hit area
- **MUST**: Mobile `<input>` font-size ≥16px to prevent iOS zoom
- **NEVER**: Disable browser zoom
- **MUST**: `touch-action: manipulation` to prevent double-tap zoom

### Forms

- **MUST**: Input prefix/suffix decorations (icons) should be absolutely positioned with padding, not adjacent; clicking them focuses input
- **MUST**: Hydration-safe inputs (no lost focus/value)
- **NEVER**: Block paste in `<input>/<textarea>`
- **MUST**: Loading buttons show spinner and keep original label
- **MUST**: Enter submits focused text input. In `<textarea>`, ⌘/Ctrl+Enter submits
- **MUST**: Keep submit enabled until request starts; then disable + spinner + idempotency key
- **MUST**: Don't block typing; accept free text and validate after
- **MUST**: Allow submitting incomplete forms to surface validation
- **MUST**: Errors inline next to fields; on submit, focus first error
- **MUST**: `autocomplete` + meaningful `name`; correct `type` and `inputmode`
- **SHOULD**: Disable spellcheck for emails/codes/usernames
- **SHOULD**: Placeholders show example pattern (eg, `+1 (123) 456-7890`)
- **MUST**: Warn on unsaved changes before navigation
- **MUST**: Compatible with password managers & 2FA; allow pasting one-time codes
- **MUST**: Trim values to handle trailing spaces
- **MUST**: No dead zones on checkboxes/radios; label+control share one hit target

### State & Navigation

- **MUST**: URL reflects state (filters/tabs/pagination). Prefer [nuqs](https://nuqs.dev)
- **MUST**: Back/Forward restores scroll
- **MUST**: Links are links—use `<a>/<Link>` for navigation (Cmd/Ctrl/middle-click works)

### Feedback

- **MUST**: Toggles should take effect immediately, not require confirmation
- **SHOULD**: Optimistic UI; reconcile on response; on failure show error + rollback or Undo
- **MUST**: Confirm destructive actions or provide Undo window
- **MUST**: Use polite `aria-live` for toasts/inline validation
- **SHOULD**: Ellipsis (`…`) for options opening follow-ups ("Rename…") and loading ("Saving…")

### Touch/Drag/Scroll

- **MUST**: Forgiving interactions (generous targets, clear affordances)
- **MUST**: Delay first tooltip in group; subsequent peers no delay
- **MUST**: `overscroll-behavior: contain` in modals/drawers
- **MUST**: During drag, disable text selection and set `inert` on dragged elements
- **MUST**: No "dead-looking" interactive zones—if it looks clickable, it is
- **MUST**: Interactive elements should disable `user-select` for inner content
- **MUST**: Decorative elements (glows, gradients) should disable `pointer-events`
- **MUST**: Hover states should use `@media (hover: hover)` to avoid flash on touch press
- **MUST**: Apply `muted` and `playsinline` to `<video>` for auto-play on iOS
- **MUST**: Disable native `touch-action` for custom pan/zoom gestures
- **MUST**: Replace default iOS tap highlight (`-webkit-tap-highlight-color: transparent`) with appropriate alternative

### Autofocus

- **SHOULD**: Autofocus on desktop with single primary input; rarely on mobile (avoids layout shift)

---

## Animation

- **MUST**: Honor `prefers-reduced-motion` (provide reduced variant)
- **SHOULD**: Prefer CSS > Web Animations API > JS libraries
- **MUST**: Animate compositor-friendly props; avoid layout-triggering props
- **SHOULD**: Animate only to clarify cause/effect or add deliberate delight
- **MUST**: Animations are interruptible and input-driven (avoid autoplay)
- **MUST**: Correct `transform-origin` (motion starts where it "physically" should)
- **MUST**: Theme switching should not trigger transitions on elements
- **SHOULD**: Animation duration ≤200ms for interactions to feel immediate
- **SHOULD**: Animation values proportional to trigger size (scale from ~0.96, not 0→1; dialogs fade + scale from ~0.8)
- **SHOULD**: Frequent/low-novelty actions (right-click menus, list add/remove) should avoid extraneous animations
- **MUST**: Looping animations should pause when off-screen (offload CPU/GPU)
- **SHOULD**: Use `scroll-behavior: smooth` for in-page anchors with appropriate offset

### Performance Tiers

See [Motion's Animation Performance Tier List](https://motion.dev/blog/web-animation-performance-tier-list):

| Tier | Properties | Notes |
|------|------------|-------|
| S | `transform`, `opacity` | Compositor-only, no layout/paint |
| A | `filter`, `clip-path` | Compositor with caveats |
| B | `background-color`, `box-shadow` | Paint only, no layout |
| F | `width`, `height`, `top`, `left`, `padding`, `margin` | Triggers layout, avoid |

**Motion** (framer-motion) automatically optimizes by using `transform` for layout animations, hardware acceleration, and WAAPI under the hood. Prefer it over manual CSS for complex animations.

---

## Layout

- **SHOULD**: Optical alignment; adjust ±1px when perception beats geometry
- **MUST**: Deliberate alignment to grid/baseline/edges—no accidental placement
- **SHOULD**: Balance icon/text lockups (stroke/weight/size/spacing/color)
- **MUST**: Verify mobile, laptop, ultra-wide (simulate at 50% zoom)
- **MUST**: Respect safe areas (`env(safe-area-inset-*)`)
- **MUST**: Avoid unwanted scrollbars; fix overflows

---

## Typography

- **SHOULD**: Apply `-webkit-font-smoothing: antialiased` for better legibility
- **SHOULD**: Apply `text-rendering: optimizeLegibility` for better legibility
- **SHOULD**: Subset fonts based on content, alphabet, or relevant languages
- **MUST**: Font weight should not change on hover/selected state (prevents layout shift)
- **SHOULD**: Avoid font weights below 400
- **SHOULD**: Medium-sized headings: font weight 500-600
- **SHOULD**: Use CSS `clamp()` for fluid sizing (e.g., `clamp(48px, 5vw, 72px)`)
- **MUST**: Apply `-webkit-text-size-adjust: 100%` to prevent unexpected resizing in iOS landscape

---

## Content & Accessibility

- **SHOULD**: Inline help first; tooltips last resort
- **MUST**: Skeletons mirror final content (avoid layout shift)
- **MUST**: `<title>` matches current context
- **MUST**: No dead ends; always offer next step/recovery
- **MUST**: Design empty/sparse/dense/error states
- **SHOULD**: Curly quotes (" "); avoid widows/orphans
- **MUST**: Tabular numbers for comparisons (`font-variant-numeric: tabular-nums`)
- **MUST**: Redundant status cues (not color-only); icons have text labels
- **MUST**: Use ellipsis character `…` (not `...`)
- **MUST**: `scroll-margin-top` on headings; include "Skip to content" link; hierarchical `<h1–h6>`
- **MUST**: Resilient to user-generated content (short/avg/very long)
- **MUST**: Locale-aware dates/times/numbers/currency
- **MUST**: Accurate `aria-label`; decorative elements `aria-hidden`
- **MUST**: Icon-only buttons have descriptive `aria-label`
- **MUST**: Prefer native semantics (`button`, `a`, `label`, `table`) before ARIA
- **MUST**: Non-breaking spaces to glue terms: `10&nbsp;MB`, `⌘&nbsp;+&nbsp;K`
- **NEVER**: Disabled buttons should not have tooltips (not in tab order, inaccessible)
- **MUST**: Focusable elements in sequential lists navigable with ↑↓ arrow keys
- **SHOULD**: Focusable elements in sequential lists deletable with ⌘/Ctrl+Backspace
- **SHOULD**: Dropdown menus trigger on `mousedown` (not `click`) for immediate response
- **SHOULD**: Use SVG favicon with `<style>` tag adhering to `prefers-color-scheme`
- **MUST**: Images should use `<img>` for screen readers and right-click copy
- **MUST**: HTML illustrations should have explicit `aria-label` (don't announce raw DOM)
- **MUST**: Gradient text should unset gradient on `::selection` state
- **MUST**: Nested menus should use prediction cone to prevent accidental closure when moving pointer
- **SHOULD**: Tooltips triggered by hover should not contain interactive content

---

## Performance

- **SHOULD**: Test iOS Low Power Mode and macOS Safari
- **MUST**: Measure reliably (disable extensions that skew runtime)
- **MUST**: Track and minimize re-renders (React DevTools/React Scan)
- **MUST**: Profile with CPU/network throttling
- **MUST**: Batch layout reads/writes; avoid unnecessary reflows
- **MUST**: Mutations (`POST/PATCH/DELETE`) target <500ms
- **SHOULD**: Prefer uncontrolled inputs; make controlled loops cheap
- **MUST**: Virtualize large lists (eg, `virtua`)
- **MUST**: Preload only above-the-fold images; lazy-load the rest
- **MUST**: Prevent CLS from images (explicit dimensions or reserved space)
- **SHOULD**: Large `blur()` values for `filter`/`backdrop-filter` may be slow
- **SHOULD**: Avoid scaling/blurring filled rectangles (causes banding); use radial gradients instead
- **SHOULD**: Sparingly enable GPU rendering with `transform: translateZ(0)` for unperformant animations
- **SHOULD**: Toggle `will-change` only during unperformant scroll animations, not pre-emptively
- **MUST**: On iOS, limit auto-playing videos; pause or unmount off-screen videos
- **SHOULD**: Bypass React render cycle with refs for real-time values that commit directly to DOM
- **SHOULD**: Detect and adapt to hardware/network capabilities ([react-adaptive-hooks](https://github.com/GoogleChromeLabs/react-adaptive-hooks))

---

## Design

- **SHOULD**: Layered shadows (ambient + direct)
- **SHOULD**: Crisp edges via semi-transparent borders + shadows
- **SHOULD**: Nested radii: child ≤ parent; concentric
- **SHOULD**: Hue consistency: tint borders/shadows/text toward bg hue
- **MUST**: Accessible charts (color-blind-friendly palettes)
- **MUST**: Meet contrast—prefer [APCA](https://apcacontrast.com/) over WCAG 2
- **MUST**: Increase contrast on `:hover/:active/:focus`
- **SHOULD**: Match browser UI to page background
- **SHOULD**: Avoid gradient banding (use masks when needed)
- **SHOULD**: Style the document selection state with `::selection`
- **MUST**: Auth redirects should happen server-side before client loads (avoid URL jank)
- **SHOULD**: Display feedback relative to its trigger (inline checkmark on copy, not toast)

---

## Reference

Based on:
- [Vercel Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines)
- [raunofreiberg/interfaces](https://github.com/raunofreiberg/interfaces)
