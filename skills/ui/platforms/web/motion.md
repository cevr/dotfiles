# Web motion

How the [motion](../../references/motion/index.md) rules are built in browsers: CSS transitions and animations, the Web Animations API, and Motion (`motion/react` in React, the framework-agnostic `motion` exports in Solid). Read the neutral file first; this one adds the browser tools, the CSS spellings and the web review rows.

| File | Read when |
| --- | --- |
| [motion-recipes.md](motion-recipes.md) | Building a known pattern in CSS or React: button press, dropdown, tooltip, modal, drawer, toast, accordion, staged entrance, list stagger, exits, icon cross-fade, hold-to-confirm, tab indicator, scroll reveal, crossfade blur, theme switch, reduced-motion fallback, WAAPI |
| [motion-performance.md](motion-performance.md) | Jank in a browser: the rendering pipeline, compositor thread, CSS-variable traps, `will-change`, React per-frame renders |
| [solid.md](solid.md#5-motion) | Any motion in a Solid project: every `motion/react` idiom mapped to Solid 2 |

## Tools

The [tool ladder](../../references/motion/index.md#3-pick-the-tool-cheapest-that-works) in the browser. Walk down; stop at the first that fits.

| Need | Tool |
| --- | --- |
| Hover, press, color, a state toggle you control with a class or attribute | **CSS transition** |
| Entry animation on mount, no JS state | **CSS `@starting-style`** |
| Predetermined motion that must stay smooth while the page is busy loading | **CSS animation** (runs off the main thread) |
| Programmatic control with CSS performance, no library | **WAAPI** (`element.animate()`) |
| Springs, layout animations, exit animations for unmounted components, gesture-driven values | **Motion** (`motion.dev`) |

CSS animations beat JS under load: they can run off the main thread, while `requestAnimationFrame`-based animation drops frames while the browser loads, scripts or paints. Use CSS for predetermined motion and JS for dynamic, interruptible motion. The thread model and the exceptions are in [web performance](motion-performance.md#where-it-runs).

With a motion library in React, import from `"motion/react"` when `motion` is installed, or `"framer-motion"` when that is. Where both exist, follow the imports the component or its nearest peers already use. Solid uses the framework-agnostic `motion` exports ([solid.md](solid.md#5-motion)).

Components rather than animations (a toast, a drawer, a command menu, a dropdown) come from the project: in React the `shadcn` skill (installed components, then registry search), in Solid the primitive package. Hand-rolling those is how you end up with a `<div>` dropdown and no focus management.

## Easing tokens

The [strong curves](../../references/motion/index.md#5-easing) as CSS custom properties. CSS's keywords `ease-out` and `ease` are the keyword curves, so the small recipes write them as keywords.

```css
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);        /* strong ease-out for UI */
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);    /* strong ease-in-out for on-screen movement */
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);     /* iOS-like drawer curve (from Ionic Framework) */
```

The icon curve is written inline: `cubic-bezier(0.2, 0, 0, 1)`, or Tailwind `ease-[cubic-bezier(0.2,0,0,1)]`. In Motion, `"easeOut"` is the keyword ease-out.

## Springs

The [neutral springs](../../references/motion/index.md#7-springs) in Motion:

```js
{ type: "spring", bounce: 0, duration: 0.4 }    // default: critically damped, no overshoot
{ type: "spring", bounce: 0.2, duration: 0.4 }  // only after a momentum gesture (a flick, a throw, a drag release)
{ type: "spring", duration: 0.3, bounce: 0 }    // icon cross-fade
```

Motion's `duration` is the run time of the whole spring, while the neutral (Apple) duration is the perceptual duration, which the spring settles a little after. The configs above are the tuned web values, so keep them. To match a native spring's pace, Motion's `visualDuration` (the time to visually reach the target) is the closer analog (not an exact equivalence; unverified against SwiftUI's curve). The physics form takes the parameters directly: `{ type: "spring", mass: 1, stiffness: 100, damping: 10 }`.

**Spring-based pointer interactions.** Use `useSpring` from Motion to interpolate pointer-driven values instead of updating them immediately:

```jsx
import { useSpring } from 'motion/react';

// Without spring: feels artificial, instant
const rotation = mouseX * 0.1;

// With spring: feels natural, has momentum
const springRotation = useSpring(mouseX * 0.1, {
  stiffness: 100,
  damping: 10,
});
```

Drive per-frame values like these through motion values, never through React state ([web performance](motion-performance.md#react-dont-animate-through-state)).

Vanilla Motion, for springs outside React (Solid, gesture handlers):

```js
import { animate } from 'motion';

// Critically damped default (no overshoot)
animate(el, { y: 0 }, { type: 'spring', bounce: 0, duration: 0.4 });

// Momentum interaction: a little bounce, only because a flick preceded it
animate(el, { y: target }, { type: 'spring', bounce: 0.2, duration: 0.4 });
```

## Properties

- **Name the transitioned properties**: `transition-property: scale, opacity`, never `transition: all` ([why and the Tailwind spellings](motion-performance.md#transition-only-what-changes)).
- **Trigger-anchored origin**: `transform-origin: var(--transform-origin)`, which Base UI (React) supplies; `@bible/ui` does not ([solid.md](solid.md#5-motion)). Modals keep `transform-origin: center`.
- **Motion's `x`/`y`/`scale` shorthands** run on the main thread. Keep them by default and switch to the full `transform` string when the animation must survive a busy main thread ([web performance](motion-performance.md#where-it-runs)).
- **Never drive a child's transform from a CSS variable on the parent.** It recalculates styles for every child. Set `transform` on the element directly ([web performance](motion-performance.md#two-traps-that-look-correct)).

## CSS transforms

**`translate()` percentages** are relative to the element's own size. `translateY(100%)` moves an element by its own height, regardless of actual dimensions. This is how Sonner positions toasts and how Vaul hides the drawer before animating it in. Percentages are less error-prone than hardcoded pixels and adapt to content.

```css
/* Works regardless of drawer height */
.drawer-hidden {
  transform: translateY(100%);
}

/* Works regardless of toast height */
.toast-enter {
  transform: translateY(-100%);
}
```

**`scale()` scales children too.** Unlike `width` and `height`, `scale()` also scales an element's children. When a button scales on press, its font size, icons and content scale proportionally. This is a feature, not a bug.

**3D transforms** (`rotateX()`, `rotateY()` with `transform-style: preserve-3d`) create real depth in CSS. Orbiting animations, coin flips and depth effects are possible without JavaScript:

```css
.wrapper {
  transform-style: preserve-3d;
}

@keyframes orbit {
  from {
    transform: translate(-50%, -50%) rotateY(0deg) translateZ(72px) rotateY(360deg);
  }
  to {
    transform: translate(-50%, -50%) rotateY(360deg) translateZ(72px) rotateY(0deg);
  }
}
```

**`transform-origin`** is the anchor point every transform executes from. The default is center. Set it to where the trigger lives for origin-aware interactions.

## clip-path

`clip-path: inset(top right bottom left)` defines a rectangular clipping region, and each value "eats" into the element from that side. It implements every [clip reveal](../../references/motion/index.md#clip-reveals):

```css
/* Fully hidden from right */
.hidden {
  clip-path: inset(0 100% 0 0);
}

/* Fully visible */
.visible {
  clip-path: inset(0 0 0 0);
}
```

- **Hold to delete**: an overlay clipped with `inset(0 100% 0 0)` fills to `inset(0 0 0 0)` on `:active` ([recipe](motion-recipes.md#hold-to-confirm)).
- **Tabs with perfect color transitions**: clip the active-styled copy of the tab list ([recipe](motion-recipes.md#tab-indicator-with-a-color-transition)).
- **Image reveals on scroll**: `inset(0 0 100% 0)` to `inset(0 0 0 0)` ([recipe](motion-recipes.md#scroll-reveal)).
- **Comparison sliders**: clip the top image with `clip-path: inset(0 50% 0 0)` and adjust the right inset from the drag position. Fully hardware-accelerated where the browser composites `clip-path`.

## Enter and exit

- **`@starting-style` animates entry without JavaScript.** It replaces the React pattern of a `useEffect` that sets `mounted: true` after the first render. Use it when browser support allows (Baseline 2024), and fall back to the `data-mounted` attribute pattern otherwise. Elements toggled from `display: none` also need `transition-behavior: allow-discrete` ([recipe](motion-recipes.md#entering-from-display-none)).
- **Skip state animations on first render.** In React, set `initial={false}` on an `AnimatePresence` that wraps a state swap (icon swaps, toggles, tabs, segmented controls), so the default state does not animate in on mount. Never set it around an intentional entrance such as a staggered hero ([recipe](motion-recipes.md#skip-animation-on-page-load)). In Solid, keep both states mounted and let CSS swap them, so nothing animates at mount ([solid.md](solid.md#5-motion)).
- **Exits**: Motion's `exit` prop, or `[data-ending-style]` on primitives that set it ([recipes](motion-recipes.md#exits)).

## Reduced motion and hover gating

- **Reduced motion**: run movement, scale and blur only under `@media (prefers-reduced-motion: no-preference)`; Tailwind's `motion-safe:` prefix does the same. In Motion, `<MotionConfig reducedMotion="user">` turns off transform and layout animations and keeps opacity, but blur still runs, so branch `filter` on `useReducedMotion()`. Recipes for CSS, Tailwind and Motion are in [reduced-motion fallback](motion-recipes.md#reduced-motion-fallback); the requirement's CSS is in [motion and zoom](../../references/accessibility/motion-and-zoom.md).
- **Hover gating**: `@media (hover: hover) and (pointer: fine)`. Both conditions matter: `(pointer: fine)` rules out styluses and the odd Android device that claims hover support. Tailwind 4's `hover:` variant compiles under `@media (hover: hover)` only (the hover half); Tailwind 3's compiles under no query unless `future.hoverOnlyWhenSupported` is set. Press feedback on `:active` needs no gating. The rest of the touch fixes (tap highlight, tap delay, sticky hover) are in [mobile web](mobile.md).
- **Reduced transparency and contrast**: `@media (prefers-reduced-transparency: reduce)` and `@media (prefers-contrast: more)` ([materials](../../references/motion/gestures.md#reduced-transparency-and-contrast)).

## Debugging

- **Slow motion**: set playback to 10% in the browser's Animations panel, or raise the duration 2–5x.
- **Frame by frame**: step through in the Chrome DevTools Animations panel.
- **Real devices for touch**: for drawers and swipe gestures, connect a phone over USB, open the dev server by IP address and use Safari's remote devtools. The Xcode Simulator is an alternative, but real hardware is better for gesture testing ([mobile web](mobile.md)).

## Gestures

The [gesture rules](../../references/motion/gestures.md) with Pointer Events, `requestAnimationFrame` and Motion.

- **1:1 tracking**: Pointer Events with `setPointerCapture` once dragging starts; keep the last few `pointermove` positions and timestamps for release velocity. Respond on `pointerdown` with `:active`, not on `click`.
- **Velocity handoff**: Motion takes absolute px/s velocity directly (the `velocity` option), so hand it the raw release velocity. A spring library that re-targets from the current velocity avoids the reversal "brick wall".
- **Haptics**: the Vibration API, fired on the same frame as the visual.

Flick dismissal, as in Sonner:

```js
const timeTaken = Date.now() - dragStartTime.current;
const velocity = Math.abs(swipeAmount) / timeTaken;

if (Math.abs(swipeAmount) >= SWIPE_THRESHOLD || velocity > 0.11) {
  dismiss();
}
```

Momentum projection and rubber-banding:

```js
// decelerationRate ≈ 0.998 for normal scroll feel; 0.99 for snappier
function project(initialVelocity /* px/s */, decelerationRate = 0.998) {
  return (initialVelocity / 1000) * decelerationRate / (1 - decelerationRate);
}

const projectedEndpoint = currentPosition + project(releaseVelocity);
const target = nearestSnapPoint(projectedEndpoint);   // choose target from the projection
animateSpringTo(target, { velocity: releaseVelocity }); // then hand off velocity

// The further past the bound, the less the element follows
function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}
```

[Drag to dismiss](../../references/motion/gestures.md#drag-to-dismiss) writes the offset to the dragged element on every `pointermove`, never through a CSS variable on the parent, and settles with `{ type: "spring", bounce: 0.2, duration: 0.4 }`:

```js
// Driving it through a CSS variable on the parent recalcs styles for every child.
element.style.transform = `translateY(${distance}px)`;
```

## Detection rows

The [detection checklist](../../references/motion/standards.md#detection-checklist) rows as they are spelled in web code, plus the web-only ones.

| Detection | Fix |
| --- | --- |
| `transition: all` or `transition-all` | Name the exact changing properties: `transition: transform 200ms ease-out` |
| `transform: scale(0)` or `scale-0` entrance | `scale(0.95)` + `opacity: 0` |
| Pure-fade entrance on a trigger-anchored surface | Add the initial `scale(0.95)` from `var(--transform-origin)` |
| Built-in `ease-out` on a component open/close or on-screen movement | `var(--ease-out)` (movement: `var(--ease-in-out)`) |
| `transform-origin: center` (or none) on a trigger-anchored popover, dropdown or tooltip | `var(--transform-origin)`; modals keep `center` |
| Keyframes (`animation:`) on toasts, toggles, `:hover`, `.open` or another toggled class | A CSS transition on the same properties |
| Animating `width`/`height`/`margin`/`padding`/`top`/`left` | `transform` / `opacity` (accordion `height` tolerated) |
| Animated `box-shadow` | `filter: drop-shadow(…)` |
| Motion `x`/`y`/`scale` props on motion that plays while the page is busy | The full `transform` string |
| `setProperty('--x', …)` on a parent driving child transforms | Set `transform` on the element directly |
| `setState` (React) or a widely read signal write (Solid) inside rAF, pointer, scroll or drag handlers | A direct style write or a motion value |
| Animated `blur()` above `20px` | Under `20px`; `2`–`5px` for a crossfade |
| A press scale (`:active`, `active:scale-95`, `scale-90`, `whileTap`) other than `0.96` | `0.96` |
| `:active` scale with no `:disabled` exclusion | `enabled:active:` or `:not(:disabled):active` |
| `bounce:` above `0` anywhere but a momentum gesture's release | `bounce: 0` |
| `opacity: 0` in a base rule that only an `animation` reveals | Hidden state in the `from` keyframe, `animation-fill-mode: both` |
| `translate`, `scale`, `filter` or `motion.*` animation with no `prefers-reduced-motion`, `motion-safe:` or `MotionConfig` guard | Gate it and cross-fade opacity under reduced motion |
| Ungated `:hover` motion (plain CSS, or Tailwind 3 `hover:`) | `@media (hover: hover) and (pointer: fine)` |
| Color transitions plus a theme toggle with no `disableTransitionOnChange` or override | The [theme-switch suppression recipe](motion-recipes.md#suppress-transitions-on-theme-switch) |
| `will-change: all`, or `will-change` on an element that never animates | Name the animated property or delete it |
| React: `AnimatePresence` around a state swap with no `initial={false}`, or `initial={false}` around an intentional entrance | `initial={false}` on state swaps only |
