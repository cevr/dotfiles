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

### Tailwind Data Attribute Styling

Use data attributes for conditional styling instead of `classnames` object syntax. Data attributes have higher specificity, making style precedence predictable.

```tsx
// BAD: cn/clsx object - order-dependent, verbose
<div className={cn({
  'bg-blue-500': !isActive,
  'bg-red-500': isActive,
})} />

// GOOD: data attributes - base style + conditional override
<div
  className="bg-blue-500 data-[active]:bg-red-500"
  data-active={isActive ? '' : undefined}
/>
```

**Caveat with `group`:** `group-data-*` selectors affect all descendants. Use unique attribute names if children have the same states as parents.

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

### Motion Choreography

- **SHOULD**: Spring physics for interactive elements: `type: "spring", stiffness: 100, damping: 20` — no linear easing
- **MUST**: Continuous animations (magnetic hover, cursor tracking) use `useMotionValue`/`useTransform` — never `useState` for per-frame updates
- **SHOULD**: Staggered entrances via `staggerChildren` or CSS `animation-delay` cascade; parent+children must share same client component tree
- **SHOULD**: Layout transitions via `layout`/`layoutId` for reorder, resize, shared-element animation
- **SHOULD**: Glassmorphism done right: `backdrop-blur` + `border-white/10` + `shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]` — not just blur alone

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

### Body Text

- **MUST**: Body text 15–25px; fine-tune per font (visual size varies at same px)
- **MUST**: `line-height: 1.20–1.45` (unitless); narrower columns tighter, wider columns looser
- **MUST**: Line length 45–90 characters; constrain with `max-width` on content containers
- **MUST**: `-webkit-text-size-adjust: 100%` to prevent iOS landscape resizing
- **SHOULD**: `-webkit-font-smoothing: antialiased`
- **SHOULD**: `text-rendering: optimizeLegibility`
- **SHOULD**: Dark gray body text over pure black on screens (projected light makes #000 harsh)
- **SHOULD**: CSS `clamp()` for fluid sizing
- **SHOULD**: Subset fonts; avoid weights below 400

### Headings

- **MUST**: `text-balance` for headings; `text-pretty` for body
- **MUST**: Limit to 2–3 heading levels max
- **MUST**: Minimal size increase from body (try +1–2px, not 2x)
- **MUST**: Font weight should not change on hover/selected (prevents layout shift)
- **SHOULD**: Bold headings, not italic (more contrast, easier to read)
- **SHOULD**: Medium headings: font weight 500–600
- **SHOULD**: Don't center headings (left-aligned is almost always correct)
- **SHOULD**: Suppress hyphenation in headings
- **NEVER**: Underline headings

### Emphasis & Formatting

- **MUST**: Bold and italic are mutually exclusive — never combine
- **MUST**: Sans-serif: skip italic, use bold only (sans italic is too subtle)
- **MUST**: Use sparingly — if everything is emphasized, nothing is
- **MUST**: All-caps only for <1 line (labels, short headings); always add `letter-spacing: 0.05em–0.12em`
- **MUST**: Prefer `text-transform: uppercase` over typing in caps
- **MUST**: Always enable kerning (`font-feature-settings: "kern"`)
- **MUST**: Reserve color for clickable elements — colored non-link text confuses users
- **NEVER**: Underline text (except hyperlinks)
- **NEVER**: Bold or italicize entire paragraphs

### Punctuation & Special Characters

- **MUST**: Use ellipsis character `…` (not `...`); nonbreaking space adjacent
- **MUST**: Curly quotes `"` `"` `'` `'` — never straight quotes in rendered UI text
- **MUST**: Curly apostrophes pointing downward (`'`); watch word-initial (`'70s`, `rock 'n' roll`)
- **MUST**: Non-breaking spaces: `10&nbsp;MB`, `⌘&nbsp;+&nbsp;K`, brand names
- **MUST**: En dash `–` for ranges (1–10, pages 3–5); em dash `—` for sentence breaks
- **MUST**: One space after punctuation, never two
- **MUST**: `tabular-nums` for data/comparisons
- **SHOULD**: Avoid widows/orphans
- **NEVER**: Approximate dashes with `--` or `---`; use proper `–` / `—`

### Spacing & Paragraphs

- **MUST**: Paragraph spacing via `margin` (50–100% of body size), not extra line breaks
- **SHOULD**: First-line indent OR paragraph spacing — never both
- **SHOULD**: `text-indent` for first-line indents (1–4x body size), not spaces/tabs

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
- **MUST**: Locale-aware dates/times/numbers/currency (`Intl.DateTimeFormat`, `Intl.NumberFormat` — never hardcoded formats)
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
- **MUST**: Grain/noise texture filters: fixed pseudo-element only, `pointer-events-none`, never on scrolling containers
- **MUST**: Perpetual/infinite animations: isolate in own memoized leaf component — never re-render parent

---

## Dark Mode & Theming

- **MUST**: `color-scheme: dark` on `<html>` for dark themes (fixes scrollbar, native inputs, system dialogs)
- **MUST**: `<meta name="theme-color">` matches page background; update on theme switch
- **MUST**: Native `<select>`: set explicit `background-color` and `color` (Windows dark mode renders broken defaults)
- **MUST**: Theme switching should not trigger transitions (disable transitions during switch, re-enable after paint)
- **MUST**: Inputs with `value` need `onChange` (or `defaultValue` for uncontrolled) — prevents hydration mismatch
- **SHOULD**: Guard date/time rendering against hydration mismatch (server vs client locale); use `suppressHydrationWarning` only where truly needed
- **SHOULD**: Detect language via `Accept-Language` / `navigator.languages`, not IP geolocation

---

## Copy & Microcopy

- **MUST**: Active voice: "Install the CLI" not "The CLI will be installed"
- **MUST**: Specific button labels: "Save API Key" not "Continue"
- **MUST**: Error messages follow the 5-part anatomy (see below)

### Error Message Anatomy

Every error message should include, in order:

| # | Element | Purpose | Example |
|---|---------|---------|---------|
| 1 | **Title** | Say what happened — clear, specific | "Unable to connect your account" |
| 2 | **Reassurance** | Confirm what did work | "Your changes were saved, but…" |
| 3 | **Cause** | Say why — technical cause in plain language | "…we could not connect due to a technical issue on our end." |
| 4 | **Escape hatch** | Give a way out if stuck | "If the issue keeps happening, contact Customer Care." |
| 5 | **Action** | Help them fix it — actionable next step | `[ Try Again ]` button |

- Skip reassurance (#2) only when nothing succeeded
- Primary action (#5) should always be present; secondary dismiss is optional
- Never blame the user; own the failure ("we could not" not "you failed to")
- **MUST**: Loading states end with `…`: "Saving…", "Loading…"
- **SHOULD**: Title Case for headings/buttons (Chicago style)
- **SHOULD**: Numerals for counts: "8 deployments" not "eight"
- **SHOULD**: Second person; avoid first person
- **SHOULD**: `&` over "and" where space-constrained
- **SHOULD**: Ellipsis (`…`) for options opening follow-ups: "Rename…"

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
- **SHOULD**: Rules/borders: 0.5–1pt single solid lines only; try whitespace first before adding lines
- **SHOULD**: Minimize table grid lines — let data be prominent, not the lines
- **NEVER**: Add gratuitous gradients; use only when purposeful

---

## Anti-Slop Aesthetics

### Typography

- **NEVER**: Default to Inter/Roboto/Arial — these signal "template"
- **SHOULD**: Reach for distinctive sans: Geist, Outfit, Satoshi, Cabinet Grotesk, General Sans, Plus Jakarta Sans
- **NEVER**: Serif fonts in dashboard/software UIs — serif is for editorial/marketing only

### Color

- **MUST**: Max 1 accent color per surface; saturation <80%
- **NEVER**: AI purple (#7C3AED and friends), neon gradients, rainbow accent combos
- **MUST**: Stick to one palette — don't mix warm and cool accents

### Layout

- **NEVER**: Centered hero section when content is high-variance (dashboards, feeds, tools)
- **NEVER**: Generic 3-column equal card rows — force asymmetric, split, zigzag, or bento alternatives
- **SHOULD**: Break symmetry intentionally — offset grids, varied card sizes, editorial whitespace

### Content Realism

- **NEVER**: Generic placeholder names — no John Doe, Jane Smith, Acme Corp, Nexus AI
- **NEVER**: Fake round numbers ($99.99, 1,000 users, 99.9% uptime) — use organic-looking data
- **NEVER**: AI filler words in UI copy: Elevate, Seamless, Unleash, Supercharge, Empower, Cutting-edge
- **MUST**: Use `picsum.photos` or inline SVG placeholders — never broken Unsplash `source.unsplash.com` links
- **MUST**: No emojis in UI code unless explicitly part of the design spec

### Component Libraries

- **NEVER**: Ship shadcn/ui components in default state — always customize radii, colors, shadows, and spacing to match the project's design language

---

## Anti-Patterns (flag these in review)

- `user-scalable=no` or `maximum-scale=1` — disables zoom
- `onPaste` + `preventDefault` — blocks paste
- `transition: all` — list properties explicitly
- `outline-none` / `outline: none` without `:focus-visible` replacement
- `<div>` / `<span>` with `onClick` — should be `<button>` or `<a>`
- Images without `width`/`height` — causes CLS
- Large arrays `.map()` without virtualization
- Form inputs without `<label>` or `aria-label`
- Icon buttons without `aria-label`
- Hardcoded date/number formats — use `Intl.*`
- `autoFocus` without clear justification
- Arbitrary Tailwind values (`w-[347px]`) — prefer design tokens

---

## Reference

**Creative pattern catalog**: `references/creative-patterns.md` — navigation, layout, card, scroll, gallery, typography, and micro-interaction patterns. Load when building distinctive/exploratory UI.

Distilled from:
- [Vercel Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines)
- [Butterick's Practical Typography](https://practicaltypography.com/)
- [raunofreiberg/interfaces](https://github.com/raunofreiberg/interfaces)
- [ui-skills.com](https://ui-skills.com)
