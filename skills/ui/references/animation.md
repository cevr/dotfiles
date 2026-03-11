# Animation Reference

Easing curves, timing, springs, and practical patterns for web animation. Based on Emil Kowalski's animations.dev course.

For core animation rules (performance tiers, reduced motion, choreography), see the Animation section in SKILL.md.

## Easing Decision

```
Is the element entering or exiting?
├── Yes → ease-out
└── No
    ├── Moving/morphing on screen? → ease-in-out
    ├── Hover/color change? → ease
    ├── Constant motion (marquee, ticker)? → linear
    └── Default → ease-out
```

**Never use `ease-in` for UI.** Slow start delays visual feedback — same duration feels sluggish.

## Easing Curves

### ease-out (Most Common)

User-initiated interactions: dropdowns, modals, tooltips, enter/exit.

```css
/* Sorted weak to strong */
--ease-out-quad: cubic-bezier(0.25, 0.46, 0.45, 0.94);
--ease-out-cubic: cubic-bezier(0.215, 0.61, 0.355, 1);
--ease-out-quart: cubic-bezier(0.165, 0.84, 0.44, 1);
--ease-out-quint: cubic-bezier(0.23, 1, 0.32, 1);
--ease-out-expo: cubic-bezier(0.19, 1, 0.22, 1);
--ease-out-circ: cubic-bezier(0.075, 0.82, 0.165, 1);
```

Why: fast start = instant, responsive feel. Element "jumps" toward destination then settles.

### ease-in-out (On-Screen Movement)

Elements already visible that need to move or morph. Mimics car accelerating then braking.

```css
/* Sorted weak to strong */
--ease-in-out-quad: cubic-bezier(0.455, 0.03, 0.515, 0.955);
--ease-in-out-cubic: cubic-bezier(0.645, 0.045, 0.355, 1);
--ease-in-out-quart: cubic-bezier(0.77, 0, 0.175, 1);
--ease-in-out-quint: cubic-bezier(0.86, 0, 0.07, 1);
--ease-in-out-expo: cubic-bezier(1, 0, 0, 1);
--ease-in-out-circ: cubic-bezier(0.785, 0.135, 0.15, 0.86);
```

### ease (Hover/Color)

Hover states and color transitions. Asymmetrical curve feels elegant for gentle changes.

```css
transition: background-color 150ms ease;
```

### linear (Rare)

Only for constant-speed motion: marquees, tickers, hold-to-delete progress. Feels robotic for interactive elements.

## Duration

| Element Type             | Duration  |
| ------------------------ | --------- |
| Micro-interactions       | 100-150ms |
| Tooltips, dropdowns      | 150-250ms |
| Modals, drawers          | 200-300ms |

**Rules:**
- Stay under 300ms for UI
- Larger elements animate slower than smaller
- Exit ~20% faster than entrance
- Longer travel = longer duration

### Frequency Rule

- **100+ times/day** — no animation (Raycast never animates its launcher)
- **Occasional use** — standard animation
- **Rare/first-time** — can be more special

### When to Animate

**Do:** enter/exit transitions, state changes needing continuity, user action feedback, rare interactions where delight adds value.

**Don't:** keyboard-initiated actions, hover on frequently-used elements, anything triggered 100+/day, when speed > smoothness.

**Marketing vs. Product:** Marketing allows elaborate, longer durations. Product demands fast, purposeful, never frivolous.

## Paired Elements

Elements that animate together **must** share easing and duration. Modal + overlay, tooltip + arrow, drawer + backdrop.

```css
.modal { transition: transform 200ms ease-out; }
.overlay { transition: opacity 200ms ease-out; }
```

## Springs

Springs feel more natural — no fixed duration, real physics simulation.

### When to Use

- Drag interactions with momentum
- Elements that should feel "alive" (Dynamic Island)
- Gestures that can be interrupted mid-animation
- Organic, playful interfaces

### Configuration

```js
// Apple approach (recommended) — duration + bounce
{ type: "spring", duration: 0.5, bounce: 0.2 }

// Traditional physics — mass, stiffness, damping
{ type: "spring", mass: 1, stiffness: 100, damping: 10 }
```

- **Avoid bounce** in most UI. Use for drag-to-dismiss, playful interactions.
- Keep bounce subtle (0.1-0.3) when used.
- Springs maintain velocity when interrupted — CSS animations restart from zero. Ideal for interruptible gestures.

## Framer Motion Performance

```jsx
// Hardware accelerated (transform as string)
<motion.div animate={{ transform: "translateX(100px)" }} />

// NOT hardware accelerated (more readable, uses JS)
<motion.div animate={{ x: 100 }} />
```

### CSS vs. JS

- CSS: off main thread, smoother under load, better for simple/predetermined
- JS (Framer Motion, React Spring): `requestAnimationFrame`, better for dynamic/interruptible

## Practical Patterns

### Button Press Feel

```css
button:active {
  transform: scale(0.97);
}
```

### Never scale(0)

Start from `scale(0.95)` + `opacity: 0`, not `scale(0)`. Elements should always have visible shape.

```css
/* BAD */
.element { transform: scale(0); }

/* GOOD */
.element { transform: scale(0.95); opacity: 0; }
.element.visible { transform: scale(1); opacity: 1; }
```

### Fix Shaky Animations

GPU/CPU rendering handoff causes 1px shifts at animation start/end.

```css
.element { will-change: transform; }
```

### Hover Flicker

When hover changes element position, cursor may leave, causing flicker. Animate a **child** element instead:

```css
/* BAD — parent moves under cursor */
.box:hover { transform: translateY(-20%); }

/* GOOD — child moves, parent hover area stable */
.box:hover .box-inner { transform: translateY(-20%); }
.box-inner { transition: transform 200ms ease; }
```

### Origin-Aware Popovers

Scale from trigger, not center:

```css
/* Radix UI */
.popover { transform-origin: var(--radix-dropdown-menu-content-transform-origin); }

/* Base UI */
.popover { transform-origin: var(--transform-origin); }
```

### Sequential Tooltips

First tooltip: delay + animation. Subsequent (while one is open): instant.

```css
.tooltip {
  transition: transform 125ms ease-out, opacity 125ms ease-out;
  transform-origin: var(--transform-origin);
}
.tooltip[data-starting-style],
.tooltip[data-ending-style] {
  opacity: 0;
  transform: scale(0.97);
}
.tooltip[data-instant] {
  transition-duration: 0ms;
}
```

Radix UI and Base UI support this with `data-instant`.

### Blur as Fallback

When easing/timing adjustments don't solve it, subtle blur masks imperfections:

```css
.button-transition:active {
  transform: scale(0.97);
  filter: blur(2px);
}
```

Keep blur under 20px (expensive, especially Safari).

### Touch Hit Areas

44px minimum (Apple + WCAG):

```css
@utility touch-hitbox {
  position: relative;
}
@utility touch-hitbox::before {
  content: "";
  position: absolute;
  display: block;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  width: 100%; height: 100%;
  min-height: 44px; min-width: 44px;
  z-index: 9999;
}
```

## Animation Review Format

When reviewing animations, use a before/after table:

| Before                           | After                                          |
| -------------------------------- | ---------------------------------------------- |
| `transform: scale(0)`           | `transform: scale(0.95)`                       |
| `animation: fadeIn 400ms ease-in`| `animation: fadeIn 200ms ease-out`             |
| No reduced motion support        | `@media (prefers-reduced-motion: reduce) {...}` |

## Quick Reference

| Problem                         | Fix                                             |
| ------------------------------- | ----------------------------------------------- |
| Buttons feel dead               | `transform: scale(0.97)` on `:active`           |
| Element appears from nowhere    | Start from `scale(0.95)`, not `scale(0)`        |
| Shaky/jittery                   | `will-change: transform`                        |
| Hover causes flicker            | Animate child, not parent                       |
| Popover scales from wrong point | `transform-origin` to trigger location          |
| Sequential tooltips slow        | Skip delay/animation after first                |
| Small buttons hard to tap       | 44px min hit area (pseudo-element)              |
| Something still feels off       | Subtle blur (under 20px)                        |
| Hover triggers on mobile        | `@media (hover: hover) and (pointer: fine)`     |
