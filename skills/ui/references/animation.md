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

Always `scale(0.96)`. Never below `0.95` — feels exaggerated. Use CSS transitions for interruptibility.

```css
button { transition-property: scale; transition-duration: 150ms; transition-timing-function: ease-out; }
button:active { scale: 0.96; }
```

```tsx
// Tailwind
<button className="transition-[scale] duration-150 ease-out active:scale-[0.96]">Click me</button>

// Motion
<motion.button whileTap={{ scale: 0.96 }}>Click me</motion.button>
```

**Static prop pattern** — disable scale when motion would be distracting:

```tsx
const tapScale = "active:not-disabled:scale-[0.96]";

function Button({ static: isStatic, className, children, ...props }) {
  return (
    <button
      className={cn("transition-[scale] duration-150 ease-out", !isStatic && tapScale, className)}
      {...props}
    >
      {children}
    </button>
  );
}

<Button>Click me</Button>        {/* scales on press */}
<Button static>Submit</Button>   {/* no scale */}
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
.element[data-animating="true"] { will-change: transform; }
```

Remove the attribute when the transition or animation finishes; permanent `will-change` keeps compositor resources allocated.

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

Use at least 24×24px on desktop and prefer 44×44px for touch targets. This utility implements the mobile target:

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

## Contextual Icon Animations

Animate icons on state change with `opacity`, `scale`, and `blur` — never toggle visibility.

**Exact values (don't deviate):**
- `scale`: `0.25` → `1`
- `opacity`: `0` → `1`
- `filter`: `blur(4px)` → `blur(0px)`
- Spring: `{ type: "spring", duration: 0.3, bounce: 0 }` — **bounce must be `0`**

### Motion Approach

```tsx
import { AnimatePresence, motion } from "motion/react";

function IconButton({ isActive, icon: Icon }) {
  return (
    <button>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={isActive ? "active" : "inactive"}
          initial={{ opacity: 0, scale: 0.25, filter: "blur(4px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          exit={{ opacity: 0, scale: 0.25, filter: "blur(4px)" }}
          transition={{ type: "spring", duration: 0.3, bounce: 0 }}
        >
          <Icon />
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
```

### CSS Fallback (No Motion Dependency)

Keep both icons in DOM, cross-fade. Non-absolute icon defines layout size; absolute icon overlays.

```tsx
function IconButton({ isActive, ActiveIcon, InactiveIcon }) {
  return (
    <button>
      <div className="relative">
        <div className={cn(
          "absolute inset-0 flex items-center justify-center",
          "transition-[opacity,filter,scale] duration-300 [transition-timing-function:cubic-bezier(0.2,0,0,1)]",
          isActive ? "scale-100 opacity-100 blur-0" : "scale-[0.25] opacity-0 blur-[4px]"
        )}>
          <ActiveIcon />
        </div>
        <div className={cn(
          "transition-[opacity,filter,scale] duration-300 [transition-timing-function:cubic-bezier(0.2,0,0,1)]",
          isActive ? "scale-[0.25] opacity-0 blur-[4px]" : "scale-100 opacity-100 blur-0"
        )}>
          <InactiveIcon />
        </div>
      </div>
    </button>
  );
}
```

**Rule:** Check `package.json` for `motion`/`framer-motion`. If present, use Motion. If not, use CSS cross-fade — don't add a dependency just for icon transitions.

| Animate | Don't Animate |
|---------|---------------|
| Icons appearing on hover (action buttons) | Static navigation icons |
| State change icons (play→pause, like→liked) | Decorative icons |
| Icons in contextual toolbars | Icons that are always visible |
| Loading/success indicators | Icon labels (text next to icon) |

## Enter/Exit Choreography

### Staggered Enter

Split content into semantic chunks. Stagger ~100ms. Combine `opacity`, `blur`, `translateY`.

```tsx
// Motion — staggered enter
<motion.div initial="hidden" animate="visible" variants={{ visible: { transition: { staggerChildren: 0.1 } } }}>
  {["h1", "p", "div"].map((_, i) => (
    <motion.div key={i} variants={{
      hidden: { opacity: 0, y: 12, filter: "blur(4px)" },
      visible: { opacity: 1, y: 0, filter: "blur(0px)" },
    }} />
  ))}
</motion.div>
```

```css
/* CSS-only stagger */
.stagger-item {
  opacity: 0; transform: translateY(12px); filter: blur(4px);
  animation: fadeInUp 400ms ease-out forwards;
}
.stagger-item:nth-child(1) { animation-delay: 0ms; }
.stagger-item:nth-child(2) { animation-delay: 100ms; }
.stagger-item:nth-child(3) { animation-delay: 200ms; }

@keyframes fadeInUp { to { opacity: 1; transform: translateY(0); filter: blur(0); } }
```

### Subtle Exit

Exit should be softer than enter. Small fixed `translateY`, shorter duration.

```tsx
<motion.div exit={{ opacity: 0, y: -12, filter: "blur(4px)", transition: { duration: 0.15, ease: "easeOut" } }}>
  {content}
</motion.div>
```

- Exit duration ~50% of enter (150ms vs 300ms)
- Small fixed `translateY` (e.g., `-12px`) — not full container height
- Keep directional movement to indicate where element went
- Don't remove exit animations entirely — subtle motion preserves context

### Skip Animation on Page Load

`initial={false}` on `AnimatePresence` prevents enter animations on first render. Elements in their default state shouldn't animate in on mount — only on subsequent state changes.

```tsx
// Good — icon doesn't animate on mount, only on state change
<AnimatePresence initial={false} mode="popLayout">
  <motion.span key={isActive ? "active" : "inactive"} initial={...} animate={...} exit={...}>
    <Icon />
  </motion.span>
</AnimatePresence>
```

**Don't use** when the component relies on `initial` for a first-time entrance (staggered page hero, loading state). Verify on full page refresh.

## Quick Reference

| Problem                         | Fix                                             |
| ------------------------------- | ----------------------------------------------- |
| Buttons feel dead               | `scale: 0.96` on `:active`                      |
| Element appears from nowhere    | Start from `scale(0.95)`, not `scale(0)`        |
| Shaky/jittery                   | `will-change: transform` while active           |
| Hover causes flicker            | Animate child, not parent                       |
| Popover scales from wrong point | `transform-origin` to trigger location          |
| Sequential tooltips slow        | Skip delay/animation after first                |
| Small buttons hard to tap       | 24px minimum; prefer 44px on touch              |
| Something still feels off       | Subtle blur (under 20px)                        |
| Hover triggers on mobile        | `@media (hover: hover) and (pointer: fine)`     |
