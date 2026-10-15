# Gestures and fluid motion

Apple's approach to fluid, physical interfaces, for every platform: drag, swipe, sheets, momentum, interruptible transitions, translucent materials and depth. The source is Apple's WWDC design talks, chiefly *Designing Fluid Interfaces* (WWDC 2018), plus the drag details learned building Sonner and Vaul.

The through-line: **an interface feels alive when motion starts from the current on-screen value, inherits the user's velocity, projects momentum forward, and can be grabbed and reversed at any instant.** Springs are the tool that makes all of this natural, because they are inherently interruptible and velocity-aware. The general rules for springs, easing and duration are in [motion](index.md).

Implementation: [web](../../platforms/web/motion.md#gestures) · [Apple](../../platforms/apple/motion.md#gestures) · [Android](../../platforms/android/motion.md#gestures)

## The core idea

> "When we align the interface to the way we think and move, something magical happens — it stops feeling like a computer and starts feeling like a seamless extension of us."

An interface is fluid when it behaves like the physical world: things respond instantly, move continuously, carry momentum, resist at boundaries, and can be redirected mid-motion. Everything below is a way to get closer to that.

Apple frames design as serving four human needs: **safety/predictability, understanding, achievement, and joy.** Every rule here serves one of them.

## Response: kill latency

The moment lag appears, the feeling of directness "falls off a cliff." Response is the foundation everything else is built on.

- **Respond on press-down, not on release.** Highlight a button the instant it's pressed ([press pattern](index.md#buttons-press-to-096)). Waiting for the release to show feedback feels dead.
- **Be vigilant about every latency.** Audit debounces, artificial timers, transition waits and platform tap delays (**Web:** the ~300ms tap delay, [mobile web](../../platforms/web/mobile.md)). Anything on the input path that isn't essential is a regression.
- **Feedback must be continuous *during* the interaction, not just at the end.** For a drag, slider or drawer, update the UI 1:1 with the pointer the whole way through. Never animate only when the gesture completes.

## Direct manipulation: 1:1 tracking

> "Touch and content should move together."

When the user drags something, it must stay glued to the finger and respect the offset from *where they grabbed it*. Snapping to the element's center on grab breaks the illusion immediately.

- **Keep tracking once the drag starts**, even when the pointer leaves the element's bounds. **Web:** `setPointerCapture`.
- **Track a short velocity/position history** (the last few move events), not just the current point. You'll need velocity at release.
- **Multi-touch protection.** Ignore additional touch points after the drag begins. Without this, switching fingers mid-drag makes the element jump to the new position.

```js
// Web
el.addEventListener('pointerdown', (e) => {
  if (isDragging) return; // ignore extra touch points mid-drag
  el.setPointerCapture(e.pointerId);
  const grabOffset = e.clientY - el.getBoundingClientRect().top; // respect where they grabbed
});
```

- **Write the drag offset to the dragged element's transform directly.** Routing it through UI state or a value every child re-reads makes the drag laggier as content grows ([performance](performance.md#keep-per-frame-values-out-of-ui-state)).

## Interruptibility: the single most important principle

> "The thought and the gesture happen in parallel."

Every animation must be interruptible and redirectable at any moment. A user must be able to grab a moving element mid-flight and reverse it without waiting for the animation to finish. A closing modal the user grabs again should follow the finger, not finish closing first and then reopen.

- **Never lock out input during a transition.**
- **Always animate from the *presentation* (current) value, never the target value.** On interrupt, read the element's live on-screen position and start the new animation from there. Starting from the logical or target value causes a visible jump.
- **Avoid duration-based transitions and fixed timelines for anything gesture-driven.** They can't be smoothly grabbed and reversed mid-flight. Springs animate from the current value by default, which is exactly what interruption needs. (Transitions remain right for state changes such as hover and toggles; see [motion](index.md#8-interruption).)
- **When a gesture reverses, blend velocity; don't hard-cut it.** Replacing one animation with another at a reversal creates a velocity discontinuity, a "brick wall." Springs that carry velocity through a re-target avoid it. This is what iOS's *additive animations* do natively; elsewhere, choose a spring API that re-targets from the current velocity.
- **Decompose 2D motion into independent X and Y springs.** A single spring on a 2D distance desyncs when X and Y have different velocities.

## Behavior over animation: use springs

> "Think of animation as a conversation between you and the object, not something prescribed by the interface."

A pre-scripted, fixed-duration animation can't respond to new input. A spring can: new input just changes the target, and the motion stays continuous. Reach for springs for anything a user can touch.

Apple deliberately replaced the physics triplet (mass/stiffness/damping) with two designer-friendly parameters. Think in these:

- **Damping ratio** controls overshoot. `1.0` is critically damped: no bounce, a smooth settle. Below `1.0` it overshoots and oscillates; lower is bouncier. Bounce is `1 − damping ratio`.
- **Response** is how quickly the value reaches the target, in seconds. Lower is snappier. **This is not "duration"** in the timed-animation sense: a spring has no fixed duration; its settle time emerges from the parameters. It is the *duration* of the neutral spring form ([springs](index.md#7-springs)).

**Defaults:**

- Start most UI at **damping `1.0`** (critically damped): graceful and non-distracting.
- Add bounce (**damping ~`0.8`**) **only when the gesture itself carried momentum** (a flick, a throw, a drag release). Overshoot on a menu that just faded in feels wrong; overshoot on a card you flicked feels right.

**Concrete values Apple ships:**

| Interaction | Damping | Response |
| --- | --- | --- |
| Move / reposition (e.g. PiP) | `1.0` | `0.4` |
| Rotation | `0.8` | `0.4` |
| Drawer / sheet | `0.8` | `0.3` |

The house style is critically damped springs everywhere by default, with bounce reserved for momentum-driven, physical interactions. The conversion to each platform's spring API is in [springs](index.md#7-springs).

## Velocity handoff: the seam between drag and animation

When a gesture ends, the animation must **continue at the finger's exact velocity**, so there's no visible seam between dragging and animating. This is the detail that most separates "fluid" from "fine."

Pass the pointer's release velocity as the spring's initial velocity. Some spring APIs want **relative** velocity; normalize it by the remaining distance to the target:

```
relativeVelocity = gestureVelocity / (targetValue − currentValue)
```

Example: element at `y=50`, target `y=150` (100pt to go), finger moving 50pt/s gives an initial spring velocity of `50 / 100 = 0.5`. Many APIs take absolute velocity in points (or pixels) per second instead; each platform file says which its API wants.

**Decide reverse or commit with the velocity's sign, not the position.** At release, the direction the finger was moving says what the user meant.

## Momentum: dismiss on a flick, land where it's going

> "Take a small input and make a big output."

**Momentum-based dismissal.** Don't require dragging past a distance threshold. Compute velocity as `|dragDistance| / elapsedMs`; if it exceeds ~`0.11` (pt/ms), dismiss regardless of distance. A quick flick should be enough.

```js
// Web
const velocity = Math.abs(swipeAmount) / (Date.now() - dragStartTime.current);
if (Math.abs(swipeAmount) >= SWIPE_THRESHOLD || velocity > 0.11) dismiss();
```

**Momentum projection.** Don't snap to the nearest boundary from the *release point*. Use velocity to **project the resting position**, exactly like scroll deceleration, then snap to the target nearest that projected point. This is what makes a flick feel like it throws the element.

Apple's exact projection function (from the *Designing Fluid Interfaces* sample code), in any language:

```
project(v, d) = (v / 1000) · d / (1 − d)       // v: release velocity in pt/s
                                               // d ≈ 0.998 for normal scroll feel; 0.99 for snappier
projectedEndpoint = currentPosition + project(releaseVelocity, d)
target = nearestSnapPoint(projectedEndpoint)   // choose the target from the projection
springTo(target, initialVelocity = releaseVelocity)  // then hand off velocity
```

The physics-textbook `v²/(2·decel)` is *not* what Apple ships; use the exponential-decay form above. This is the standard behavior in good bottom sheets and carousels (Vaul, Embla, the native scroll views).

## Spatial consistency: symmetric paths, anchored origins

> "If something disappears one way, we expect it to emerge from where it came."

- **Enter and exit along the same path.** A panel that slides in from the right must dismiss to the right. In-from-right and out-the-bottom feels disconnected and confusing. (Content that only fades in place exits small and short instead; see [motion enter and exit](index.md#9-enter-and-exit).)
- **Anchor interactions to their source.** A menu, popover or sheet should originate from the element that triggered it: anchor the scale at the trigger, so the spatial relationship between button and content is obvious ([popovers](index.md#popovers-scale-from-their-trigger)).

## Hint in the direction of the gesture

Humans predict a final state from a trajectory. Intermediate motion should telegraph where things are going: Control Center modules "grow up and out toward your finger." Make the in-between frames point at the outcome, not just interpolate blindly to it.

## Rubber-banding: soft boundaries

At an edge, resist progressively instead of stopping hard. A hard stop reads as "frozen"; continuous resistance reads as "responsive, but there's nothing more here." Things in real life don't suddenly stop; they slow down first.

- **Damping at boundaries.** When the user drags past the natural boundary (dragging a drawer up when it's already at the top), the more they drag, the less the element moves.
- **Friction instead of hard stops.** Instead of preventing the over-drag entirely, allow it with increasing friction. It feels more natural than hitting an invisible wall.

```
// The further past the bound, the less the element follows
rubberband(overshoot, dimension, c = 0.55) = (overshoot · dimension · c) / (dimension + c · |overshoot|)
```

## Drag to dismiss

The gesture pattern that puts the sections above together. Springs, not durations, because the user can reverse mid-motion.

1. On press: ignore it if a drag is already running (multi-touch protection), keep tracking outside the element's bounds, record the grab offset and the start time.
2. On move: past the ~10pt hysteresis, track 1:1 by writing the offset to the dragged element's transform directly, and keep a short position/time history. Past a boundary, apply `rubberband()` instead of stopping.
3. On release: dismiss when the distance passes the swipe threshold **or** the velocity passes ~`0.11` pt/ms. Otherwise project the endpoint and snap to the nearest point.
4. Settle with a spring that receives the release velocity, so an interrupted drag keeps its speed: duration `0.4`, bounce `0.2` (the momentum release, the one place bounce belongs).

Test it on a real device: emulation cannot reproduce how a flick or a rubber-band feels.

## Gesture design details: the feel checklist

- **Tap:** highlight on touch-*down* (instant), commit on touch-*up*. Add ~10pt of hysteresis/hit padding around the target, and allow cancel-by-dragging-away and back.
- **Drag/swipe:** require a small movement threshold (hysteresis, ~10pt) before committing to a direction, then track 1:1.
- **Detect all plausible gestures in parallel from the first move**, then confidently cancel the losers once intent is clear. Avoid recognizers that only report a *final* state (a `swipeleft`-type event); they throw away the continuous tracking you need for feedback.
- **Minimize disambiguation delays.** Double-tap detection unavoidably delays single taps; only pay that cost where double-tap truly exists.

## Materials and depth: translucency conveys hierarchy

Apple uses translucent materials as a floating functional layer that brings structure without stealing focus. Apple and Android ship system materials; the web approximates them with `backdrop-filter`.

- **Build nav, toolbars and sheets as translucent layers** (a blurred, semi-transparent background) with content scrolling underneath, not opaque bars that consume a fixed strip.
- **Material weight encodes hierarchy:** darker, heavier materials separate structural regions (sidebars); lighter materials draw attention to interactive elements (buttons). **Never stack a light translucent surface on another**: legibility collapses.
- **Bigger surfaces should read as thicker:** stronger blur plus a deeper shadow than small chips. Consider context-aware shadow: heavier over busy or text content for separation, lighter over plain backgrounds. The shadow values themselves are in [shadow recipes](../surfaces.md#shadow-recipes).
- **Dim to focus, separate to keep flow.** A modal task pairs the surface with a dimming scrim and pushes the background back or down. A parallel, non-blocking panel uses translucency and offset *without* a scrim, so the flow isn't broken. For stacked sheets, progressively dim and push back each parent layer.
- **Vibrancy keeps text legible over changing backgrounds.** Over blurred or translucent surfaces, don't use flat gray text: use higher contrast, slightly heavier weight and a small letter-spacing bump. Put color on a solid layer, not the translucent foreground.
- **Scroll edge effects, not hard dividers.** Instead of a 1pt border under a sticky header, fade a small blur or gradient mask where content meets floating chrome, only where floating UI actually overlaps content.
- **Materialize, don't just fade.** For small glass surfaces (popovers, chips), animate blur radius (under `20pt`) and scale together on enter and exit, so the surface reads as a real material arriving rather than a plain opacity fade. On large surfaces (sheets, full-width toolbars) keep the backdrop blur static and animate opacity and transform: animated blur on a large area is expensive, especially in Safari ([performance](performance.md#blur)).

```css
/* Web */
.toolbar {
  background: rgba(255, 255, 255, 0.6);
  backdrop-filter: blur(20px) saturate(180%);
  border-top: 1px solid rgba(255, 255, 255, 0.4); /* bright top edge = light catching the material */
}
```

### Reduced transparency and contrast

Bake two more preferences into translucent components, alongside [reduced motion](index.md#reduced-motion-and-pointer-gating):

- **Reduced transparency**: make translucent surfaces frostier or solid: raise background opacity, drop the blur.
- **Increased contrast**: near-solid backgrounds with a defined, contrasting border.

```css
/* Web: prefers-reduced-transparency and prefers-contrast: more */
@media (prefers-reduced-transparency: reduce) {
  .toolbar { background: white; backdrop-filter: none; }
}
```

## Multimodal feedback: motion, sound and haptics

Three rules for combining senses (from *Designing Audio-Haptic Experiences*):

1. **Causality.** It must be obvious what caused the feedback. Trigger it on the actual causal event (the toggle flipping, the item snapping home), and match its character to the action's physicality.
2. **Harmony.** The visual, the sound and the haptic must fire on the **same frame**. Latency between them destroys the illusion. Don't let a transition lag the audio or haptic.
3. **Utility.** Add feedback only where it earns its place. Reserve haptics and sound for meaningful moments (success, error, commit, snap). Over-feedback trains users to ignore all of it.

## Typography

Apple's type rules (optical sizing, size-specific tracking, leading) are covered in [typography](../typography/index.md).

## Design foundations

The principles this motion serves (Apple's eight, plus wayfinding, feedback kinds, and mapping) live in [interface judgment](../interface-judgment.md#principles-behind-the-rules), along with the prototyping process.

## Quick reference

| Need | Technique | Concrete value |
| --- | --- | --- |
| Default UI spring | Critically damped, no overshoot | damping `1.0`, response `0.3–0.4` (bounce `0`) |
| Momentum / flick spring | Under-damped, slight bounce | damping `~0.8`, response `0.3–0.4` (bounce `0.2`) |
| Gesture → spring velocity | Hand off release velocity | `gestureVelocity / (target − current)` if normalized |
| Flick dismissal | Velocity, not just distance | `|distance| / elapsedMs > ~0.11` |
| Flick landing point | Project momentum | `current + (v/1000)·d/(1−d)`, `d ≈ 0.998` |
| Interrupt cleanly | Start from presentation (live) value | read the on-screen position |
| Avoid reversal "brick wall" | Carry velocity through re-target | spring that blends velocity |
| Decide reverse vs. commit | Use velocity **sign**, not position | at release |
| 1:1 drag | Keep tracking outside the bounds | respect the grab offset; ignore extra touch points |
| Feedback | On press-down, continuous | never only at the end |
| Boundary | Rubber-band, don't hard-stop | progressive resistance, `c = 0.55` |
| Translucent chrome | A material layer | content scrolls under |
| Reduced motion | Cross-fade, not slide/spring | the platform's reduced-motion setting |
