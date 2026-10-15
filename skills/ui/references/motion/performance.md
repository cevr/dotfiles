# Motion performance

Make motion land every frame: animate render-only properties, keep per-frame work off a busy main thread, and find the cause when an animation drops frames. The question here is never "does it look right?" but "does each frame finish in time?". Easing, duration and whether to animate at all are in [motion](index.md); React Native's threads are out of scope.

Imagine [Sonner](https://sonner.emilkowal.ski/) running at 30fps. Same easing, same durations, same code. Nobody would have cared. Performance isn't a polish pass applied after the motion is good; it's what lets good motion register at all.

Implementation: [web](../../platforms/web/motion-performance.md) · [Apple](../../platforms/apple/motion.md#performance) · [Android](../../platforms/android/motion.md#performance)

## Operating posture

Treat the developer's machine as the least representative device the animation will ever run on. Every trap below has bitten drawers, toasts and dashboards in production.

Two failure modes, and the first is worse:

1. **"It's smooth on my machine."** A fast laptop, or a simulator running on one, hides almost every problem in this file. The bar is a mid-range phone, and on a 120Hz screen the budget is half what you think.
2. **Sprinkling a layer or rasterization hint and calling it fixed** (web `will-change`). It's the last step, not the first. Most jank is the wrong property or a busy main thread, and a hint fixes neither.

## Hard rules

1. **Transform and opacity by default.** Anything else needs a reason. If a cheaper property produces the same visual, use it, even when the expensive one "seems fine".
2. **Name the cause before changing code.** Every fix you propose names which of the causes below it addresses. "Added a layer hint, seems smoother" is not a diagnosis.
3. **Never conclude "it's fine" from a fast machine.** Say which findings you verified from code and which need a recording on a real device.
4. **Name the properties that animate** ([properties](index.md#4-pick-the-properties)). An animation scoped to everything that changes animates layout nobody meant to.
5. **Don't trade correctness for a best-effort optimization.** Hardware acceleration is something the platform may grant. Which properties you animate is something you control. Spend effort on the second.

## The symptom table

Start here. Match what the user is seeing, then read the matching section. Each platform file adds its own rows.

| Problem | Solution |
| --- | --- |
| Animation stutters | Animate transform and opacity, not size, padding, margins or position in the flow |
| Jank only during navigation or loading | Move the animation to a driver that runs off the main thread, or keep the main thread free while it plays |
| Hand-rolled animation drops frames | Write per-frame values to the rendered element, not to UI state |
| Animation gets laggier as content grows | Find what each frame invalidates across descendants; touch only the animating element |
| Blur transition lags | Keep animated blur under `20pt` |
| Unexpected properties animate | Scope the animation to the named properties |

## The frame budget

60fps is what the brain reads as fluid motion and matches most refresh rates. It gives the renderer **16.7ms** (1000/60) per frame. On a 120Hz screen, now most phones and many laptops, it's **8ms**. Design against the smaller number.

For scale: a layout recalculation on a complex screen can take over 100ms. That isn't one missed frame, it's a dozen.

Two things decide whether you stay inside the budget:

1. **What you animate**: how much work each frame costs.
2. **Where it runs**: whether that work can be blocked by everything else the app is doing.

Smoothness is also about *what's in the frames*, not just the frame rate. Keep the per-frame positional change below the perception threshold to avoid strobing. For very fast motion, a subtle motion blur or stretch encodes speed and reads better than a hard, sharp streak. Per-frame work runs on the platform's display-synced clock, never on a timer.

## What you animate

Every UI renderer turns a change into up to three kinds of work: **layout** (measure and place elements), **draw** (render their contents) and **composite** (put the drawn layers on screen). Each property enters at one of those points, and the cost differs by an order of magnitude:

| Tier | Properties | Cost |
| --- | --- | --- |
| Composite only | translation, scale, rotation, opacity; on most renderers also clip and blur | Cheapest. Nothing is re-measured or redrawn. |
| Draw + composite | shadow, corner radius, color, a path's shape | No re-measuring, but a redraw every frame. |
| Layout + draw + composite | size, padding, margins, position in the layout flow, border width | Most expensive. One growing element can move everything around it. |

Transform and opacity change how an element looks, not where it sits in the layout, so nothing needs re-measuring. The platform files name each tier's properties and their cheaper swaps.

**Swapping down a tier:**

| Instead of | Animate |
| --- | --- |
| size or padding to grow or shrink | scale |
| position or margins to move | translation, by a fraction of the element's own size |
| showing and hiding | opacity |

An animated shadow looks harmless but redraws the element every frame; each platform file gives its cheaper form.

Two things follow:

- **Layout animations don't always drop frames.** An element outside the flow, or one with few children, may animate padding without visible cost. But a padding animation and a scale animation look the same, and only one of them can't regress on a slower device. Pick the one with no downside.
- **Layout properties also move the wrong things.** Animating a sidebar's leading margin pushes the content beside it on every frame; a translation doesn't. For a dashboard next to an opening sidebar, that's the whole screen re-laid-out 60 times a second.

## Where it runs

Code that computes each frame on the main (UI) thread competes with everything else the app is doing there. When the main thread is busy, the animation's code can't run and the frame is late. Some drivers hand the animation to the renderer or compositor once started, so it stays smooth no matter what the app's code is doing; which ones do is platform-specific and listed in each platform file.

**The pattern to watch for is motion that runs while the app is doing heavy work**: screen transitions, tab indicators during navigation, anything that fires alongside data fetching, first render or hydration. Either move that motion to an off-main-thread driver or move the work out of its way.

## Keep per-frame values out of UI state

Animation APIs animate outside the UI framework's update cycle, so they're fine. The trap is a hand-rolled animation that writes UI state every frame: each write re-runs the framework's update (a React render, a SwiftUI body evaluation, a Compose recomposition) and that alone blows the budget.

Write per-frame values where the framework reads them late: straight to the rendered element's transform, or into the platform's animated-value type. Look for state writes inside frame callbacks, pointer-move, scroll or drag handlers. Continuous effects such as magnetic hover and cursor tracking belong in animated values for the same reason.

A per-frame value that every descendant re-reads (an inherited variable, an environment value, a composition local read during composition) costs the same: each frame invalidates the whole subtree, and the animation slows as content grows.

## Blur

Animated blur gets expensive fast, especially on the web in Safari. Keep animated blur under `20pt`; `2`–`5pt` is enough to soften a crossfade.

## Page-level costs

- A perpetual animation (spinner, marquee, ambient gradient) runs in the cheapest declarative driver, isolated in its own leaf component so its updates never re-run the tree around it.
- Never scale or blur a large filled rectangle; paint the glow or vignette with a radial gradient.
- Mutations (create, update, delete) target under 500ms; past that, show optimistic state or progress.
- Load only the images on screen and defer the rest; adapt heavy effects to the device's capability and data-saver setting.

## Diagnosing jank

### Phase 1: Find what animates

List every animation in scope with its driver and properties:

| Element | Driver | Properties | Plays during |
| --- | --- | --- | --- |
| Tab indicator | shared-element layout animation | layout | route change |
| Drawer | declarative transition | transform | user drag |
| Card hover | transition scoped to everything | all | hover |

Expand any animation scoped to "everything that changes", and any shorthand, into what it actually animates.

### Phase 2: Diagnose

Work down this list. It's ordered by how often each one is the cause:

1. **Which properties animate?** Anything other than transform and opacity is the first suspect: layout properties first, then shadow and corner radius, which don't look like layout and are easy to miss.
2. **Does the jank coincide with the app being busy?** Navigation, fetching, first render, a long task. Move the animation off the main thread, or the work out of its way.
3. **Is the framework doing work per frame?** UI state writes in frame, pointer, scroll or drag handlers ([per-frame values](#keep-per-frame-values-out-of-ui-state)).
4. **Does it get worse as content grows?** A per-frame value every descendant re-reads, or too many nodes animating at once.
5. **Any animated blur above `20pt`?**
6. **The platform's own causes**, listed in each platform file (web: animated CSS variables, then `will-change`).

Confirm with a recording, not by feel: the platform's profiler for dropped frames and long main-thread work, and its slow-animation setting to watch the motion. Profile on a real mid-range phone. A desktop simulator or emulator, even throttled, models neither a weak GPU nor a small memory budget.

### Phase 3: Report

For each finding:

```
**[Element]**: `file:42`
Cause: [which of the causes above]
Before: the animation that triggers the cost (e.g. animates padding, triggers layout)
After: the cheaper property and its exact value (e.g. scale to 0.96)
Verified: from code / needs a device recording
```

Order findings by cost: layout before draw, busy-main-thread before idle. Then stop. Apply fixes when asked.
