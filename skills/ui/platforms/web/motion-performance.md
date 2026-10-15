# Web motion performance

How browsers decide whether motion lands every frame: the rendering pipeline, the compositor thread, CSS-variable and blur traps, `will-change`, and React and Solid per-frame work. The frame budget, the cost tiers, the diagnosis order and the report format are in [motion performance](../../references/motion/performance.md); this file adds what a browser does.

## Symptoms

| Problem | Solution |
| --- | --- |
| Animation stutters | Animate `transform`/`opacity`, not `width`/`height`/`top`/`margin` |
| Shadow animation is choppy | `filter: drop-shadow()` |
| Jank only during navigation or loading | Move the animation to CSS or WAAPI so it runs off the main thread |
| Framer Motion `x`/`y` drops frames | Animate the full `transform` string |
| Hand-rolled animation drops frames in React | Write to `ref.current.style`, not state |
| Drag gets laggier as the list grows | Stop animating an inherited CSS variable; set `transform` directly |
| Blur transition lags (especially Safari) | Keep animated `blur()` under 20px |
| Unexpected properties animate | Replace `transition: all` with explicit properties |
| Element shifts 1px or stutters on the first frame when motion starts or ends | `will-change` naming the animated property, only once you see it |

`requestAnimationFrame` is the browser's display-synced clock for per-frame work.

## The browser pipeline

To show a visual change, the browser runs up to three steps: **layout** (size and position of every element), **paint** (draw the page into layers) and **composite** (put those layers on screen). The property tiers in [what you animate](../../references/motion/performance.md#what-you-animate) map to them:

| Tier | Properties |
| --- | --- |
| Composite only | `transform`, `opacity`, and in current Chrome/Firefox also `filter`, `clip-path`, `background-color`. Browsers promote these to their own layer. Anything beyond `transform` and `opacity` needs testing across browsers and devices; support is uneven. |
| Paint + composite | `box-shadow`, `border-radius`, `color` |
| Layout + paint + composite | `width`, `height`, `padding`, `margin`, `top`, `left`, `border-width` |

| Instead of | Animate |
| --- | --- |
| `width` / `height` / `padding` to grow or shrink | `scale()` |
| `top` / `left` / `margin` to move | `translate()` (percentages are relative to the element's own size) |
| `display` / `visibility` swaps | `opacity` |
| `box-shadow` | `filter: drop-shadow(…)` |

The last one is the one people miss. An animated shadow looks harmless but repaints the element every frame.

## Transition only what changes

`transition: all` animates properties nobody meant to animate, such as colors on a theme flip. On layout properties such as `width` and `padding` it re-runs layout on every frame. Tailwind's bare `transition` is a curated list rather than `all`, and still covers more than most elements change.

```css
/* Good: only what changes */
.button {
  transition-property: scale, background-color;
  transition-duration: 150ms;
  transition-timing-function: ease-out;
}

/* Bad: everything */
.button {
  transition: all 150ms ease-out;
}
```

```tsx
// Good: explicit properties
<button className="transition-[scale,background-color] duration-150 ease-out">

// Bad: transition all
<button className="transition-all duration-150 ease-out">
```

In Tailwind 4, `transition-transform` covers `transform, translate, scale, rotate`, and in Tailwind 3 only `transform`. Use it when animating transforms alone. Mixing transform and other properties takes the bracket syntax, as in `transition-[scale,opacity,filter]`.

## Where it runs

**JavaScript always runs on the main thread.** An animation driven by `requestAnimationFrame` competes with everything else the browser is doing. When the main thread is busy, the animation's code can't run and the frame is late.

| Driver | Thread |
| --- | --- |
| JS + `requestAnimationFrame` (GSAP, `motion/react` components) | Main thread, always |
| Web Animations API (`element.animate()`, Motion's `animate()`) | Can be hardware-accelerated |
| CSS transitions and keyframes | Can be hardware-accelerated |

Hardware acceleration means the animation runs off the main thread, so it stays smooth no matter what JavaScript is doing. "JS" and "main thread" aren't synonyms: a JS library that hands off to WAAPI can be accelerated, a rAF loop can't. WAAPI gives JavaScript control with CSS performance, interruptible and with no library ([recipe](motion-recipes.md#programmatic-without-a-library)).

Reliably accelerated: `transform` and `opacity`. Gaining support: `filter`, `clip-path`, `background-color`.

Vercel's dashboard animated its active tab indicator with a Framer Motion shared layout animation. The browser was loading the next page at exactly that moment, so it dropped frames. Moving it to a CSS animation fixed it. Watch for the same during page transitions, data fetching and hydration.

Framer Motion can be accelerated, but only when the transform is a string:

```jsx
<motion.div animate={{ x: 100 }} />                          // main thread, can jank
<motion.div animate={{ transform: "translateX(100px)" }} />  // hardware-accelerated
```

The `x`, `y`, `scale`, `rotate` shorthands are implemented with CSS variables, and animated CSS variables aren't accelerated. The shorthands read better, so keep them by default and switch to the string form when the animation has to survive a busy main thread.

**Acceleration is progressive enhancement.** Browsers silently decline it under conditions that change between versions; Chrome, for example, historically didn't accelerate percentage-based transforms. That's not a reason to stop using `translateY(100%)`. Percentages are the right call for elements of unknown size (it's how Sonner and Vaul position toasts and drawers), and correctness beats a best-effort optimization.

## React: don't animate through state

Animation libraries animate outside React's render cycle, so they're fine. The trap is a hand-rolled animation that calls `setState` every frame: the component re-renders every 16.7ms and the render alone blows the budget.

```jsx
// Drops frames: one re-render per frame
setY(nextY);

// Smooth: no re-render
ref.current.style.transform = `translateY(${nextY}px)`;
// or with a motion value: y.set(nextY)
```

Look for state updates inside `requestAnimationFrame`, `pointermove`, `scroll` or drag handlers. Continuous effects such as magnetic hover and cursor tracking belong in motion values (`useMotionValue`, `useTransform`, `useSpring`) for the same reason.

Solid has no re-render, but a per-frame signal write still queues a flush and updates every subscriber. Write the style directly there too ([solid.md](solid.md#2-reactivity-what-react-performance-advice-means-here)).

## Two traps that look correct

Both of these use `transform` and still drop frames.

**Inherited CSS variables.** Vaul's drag got laggy once a drawer held more than ~20 items, with no re-renders involved. The drag distance was written to a CSS variable that `translateY()` read:

```js
// Recalculates styles for every descendant, every frame
element.style.setProperty('--swipe-amount', `${draggedDistance}px`);

// Only touches this element
element.style.transform = `translateY(${draggedDistance}px)`;
```

CSS variables inherit, so changing one on a parent triggers style recalculation for every child. The more content, the slower each frame. Suspect this whenever a `transform` animation degrades as content grows. It's the same reason Framer Motion's shorthands aren't accelerated.

**Blur.** `filter: blur()` gets expensive fast, especially in Safari. Keep animated blur under `20px`; `2`–`5px` is enough to soften a crossfade.

## Use will-change sparingly

`will-change` promotes an element to its own compositing layer ahead of time. Without it the browser promotes when the animation starts, and that one-time hand-off from CPU to GPU can stutter on the first frame or shift the element by a pixel at the start or end.

**Add it only once you see the shift, the first-frame stutter or measured dropped frames.** Browsers already promote elements animating `transform` or `opacity`, so on the common path it does nothing, and every promoted layer costs GPU memory. Never add it preemptively. Put it on the element that animates, never on `*` or large containers, and name the property you animate: `scale` for `scale`, `transform` for `transform`.

```css
/* Good: names the property that animates */
.animated-card {
  will-change: scale, opacity;
}

/* Bad: never all */
.animated-card {
  will-change: all;
}

/* Bad: these never composite */
.animated-card {
  will-change: background-color, padding;
}
```

| Property | Worth `will-change` |
| --- | --- |
| `transform`, `translate`, `scale`, `rotate` | Yes |
| `opacity` | Yes |
| `filter` | Yes |
| `clip-path` | Rarely, since compositing it is not reliable across browsers |
| `top`, `left`, `width`, `height` | No |
| `background`, `border`, `color` | No |

Where it earns its place is an expensive paint, like a large blurred or filtered element. Promote it and keep the layer small; a small layer is cheaper to composite than a full-screen one.

`will-change` on a transform property or `filter` makes the element the containing block for its `position: fixed` descendants, so a fixed modal or tooltip inside it stops tracking the viewport. Any of these values also creates a stacking context, which can reorder `z-index` against siblings.

## Should you avoid JS animation?

No. Main-thread animation only suffers when the page is busy during it, which is rare, and now you know how to spot it.

Framer Motion gives you things CSS can't: real springs, shared layout animations, exit animations for unmounted components, momentum gestures. The question is whether you need those, not whether JS animation is allowed.

**The working split:** CSS for simple and predetermined motion and anything that plays while the page is busy; Framer Motion for complex, interruptible, gesture-driven motion.

## Page-level costs

- A perpetual animation (spinner, marquee, ambient gradient) runs in CSS where it can. In React, a JS-driven one lives in its own memoized leaf component.
- Grain or noise texture is a `position: fixed`, `pointer-events: none` pseudo-element on the page, never on a scrolling container.
- Preload only above-the-fold images and lazy-load the rest; adapt heavy effects to the device with `navigator.hardwareConcurrency` and `navigator.connection?.saveData`.

## Diagnosing in the browser

Phase 1 of [diagnosing jank](../../references/motion/performance.md#diagnosing-jank) expands `transition: all` and Motion shorthands into what they actually animate. Phase 2 adds these web causes to the neutral list, in this order after the framework check:

1. **Is a CSS variable animated at all?** Directly, through an inherited variable on a parent, or through Motion's `x`/`y`/`scale`.
2. **Still shifting or stuttering?** Now add `will-change` naming the animated property to the animating element.

Record with the DevTools Performance panel for dropped frames and long tasks, and the Animations panel to slow motion down. Profile on a real mid-range phone over remote debugging. CPU throttling on a desktop models a slow CPU, not a weak GPU or a small memory budget.
