# Motion

Whether to animate, what for, and with which ingredients: frequency, purpose, tool, properties, easing, duration, springs, interruption, enter and exit, component principles and their exact pattern values, reduced motion and debugging. The build sequence below is the order the decisions are made in. Each step gates the next, so a curve is never chosen before the motion has earned the right to exist.

Read this file before writing or changing any animation. Values are in points (CSS `px`, Apple `pt`, Android `dp`) and milliseconds; curves are cubic-bezier control points `(x1, y1, x2, y2)`; springs are a duration and a bounce ([springs](#7-springs)). The sub-files at the end hold the review bar, performance diagnosis, gestures and the glossary.

Implementation: [web](../../platforms/web/motion.md) · [Apple](../../platforms/apple/motion.md) · [Android](../../platforms/android/motion.md)

## Why the craft matters

**Taste is trained, not innate.** Good taste is not personal preference. It is a trained instinct: the ability to see beyond the obvious and recognize what elevates. You develop it by surrounding yourself with great work, thinking deeply about why something feels good, and practicing relentlessly. Don't just make it work. Study why the best interfaces feel the way they do. Reverse engineer animations. Inspect interactions.

**Unseen details compound.** Most details users never consciously notice. That is the point. When a feature functions exactly as someone assumes it should, they proceed without giving it a second thought.

> "All those unseen details combine to produce something that's just stunning, like a thousand barely audible voices all singing in tune." - Paul Graham

**Beauty is leverage.** People select tools based on the overall experience, not just functionality. Good defaults and good animations are real differentiators.

**Polish never outranks a broken interaction.** Motion polish applies once the underlying interaction is sound. A motion finding never outranks a broken interaction.

## Hard rules

1. **Run the sequence in order.** Steps 1 and 2 gate everything. Don't reach for a curve before you know whether it animates at all.
2. **Values are exact, not ranges to approximate.** Every curve, duration and spring config comes from the tables below and the [pattern values](#pattern-values). `cubic-bezier(0.2, 0, 0, 1)` is not `cubic-bezier(0.4, 0, 0.2, 1)`, and `0.96` is not `0.95`. Never invent a curve because it looks familiar.
3. **Extend the codebase's tokens, don't fork them.** If an easing token, a duration scale or a shared animation constant already exists, use it. Adding a parallel system is a defect. Match the project's motion language wherever no rule here gives a value. A deliberate and consistent project convention is a preference, not a finding. The same detail done two ways within the project is a finding.
4. **Reduced motion and hover gating ship with the animation**, not as a follow-up.
5. **Cheapest tool that works.** Don't add a motion library for a fade.
6. **Motion is never the only feedback channel.** Every animated state change also leaves a static cue in the form of a color, icon or label.

Two failure modes, and the first is worse:

1. **Animating something that shouldn't animate.** The gate below exists to produce zero lines of code sometimes. That's a success, not a dodge.
2. **Animating the right thing with the wrong ingredients**: `ease-in` on an entrance, an entrance from scale `0`, a fixed-timeline animation on a toast, a duration that makes a dropdown feel sluggish.

Never present motion options as a menu. Make the call, state the reasoning in one line, write the code.

## 1. Should this animate at all?

Ask how often a user will see it.

| Frequency | Decision |
| --- | --- |
| 100+ times/day (keyboard shortcuts, command palette toggle, core navigation, focus jumps) | **No animation. Ever.** Stop here. |
| Tens of times/day (hover effects, row hovers, list navigation, tab switches, frequent toggles, keystroke feedback) | Instant feedback, or a transition of `150ms` or less on opacity or background color only. Nothing expressive. |
| Occasional (modals, drawers, toasts, settings) | Standard animation |
| Rare / first-time (onboarding, a view's first load, empty states, success, celebration) | The delight budget lives here. Expressive motion such as a staged entrance belongs only at this tier. |

**Keyboard-initiated actions are a disqualifier, not a judgment call.** They repeat hundreds of times daily, and animation makes them feel slow, delayed and disconnected from the user's action. Raycast has no open/close animation, which is correct for something opened hundreds of times a day.

Press feedback on a button is the confirmation itself, so it follows its own rule ([Buttons](#buttons-press-to-096)), with an opt-out where it would distract.

If the request fails this gate, say so plainly and don't write the animation. Offer the non-motion alternative (an instant state change, a static affordance) instead.

## 2. What is the purpose?

Name it in one of these words before continuing:

- **Feedback**: confirming the interface heard the user (a button scales down on press)
- **Spatial consistency**: showing where something came from or went (a toast enters and exits from the same direction, which makes swipe-to-dismiss feel intuitive)
- **State indication**: making a state change legible (a morphing feedback button)
- **Preventing a jarring change**: bridging content that would otherwise teleport, appear or vanish
- **Explanation**: demonstrating how something works (marketing and onboarding only)
- **Delight**: allowed *only* at the rare/first-time tier

Can't name it? Don't build it. "It looks cool" on a frequently-seen element is a reason to stop.

Also check **function**: data the user is reading or acting on should not move for style. A decorative mouse-tracking effect belongs on a marketing page, not on a functional graph in a banking app, where no animation is better.

## 3. Pick the tool, cheapest that works

Walk down; stop at the first that fits. Each platform file names its tool for every rung.

| Need | Tool |
| --- | --- |
| Hover, press, color, a state toggle | The platform's declarative state transition, which retargets from the current value |
| An element entering or leaving | The platform's enter and exit transition |
| Predetermined motion that must stay smooth while the app is busy loading | A driver that runs off the main thread, where the platform has one |
| Programmatic control (start, stop, sequence) | The platform's imperative animation API |
| Springs with velocity, layout and shared-element animation, gesture-driven values | A physics- and gesture-aware animation API or library |

Predetermined motion goes to the cheapest declarative driver; dynamic, interruptible motion goes to code. Main-thread animation drops frames while the app loads, scripts or lays out ([performance](performance.md#where-it-runs)).

If the task needs a *component* rather than an animation (a toast, a drawer, a command menu, a dropdown), stop and get it from the project's components or the platform's system components. Hand-rolling those is how you end up with a dropdown that has no focus management.

## 4. Pick the properties

- **Transform (translation, scale, rotation) and opacity by default.** They skip layout and redraw. Size, padding, margins and position in the layout flow re-run layout on every frame. A clip is the sanctioned extra ([clip reveals](#clip-reveals)), blur is fine under `20pt`, and height is tolerated only for accordions, where there is no transform equivalent. The full cost tiers and cheaper swaps are in [performance](performance.md#what-you-animate).
- **Name the properties that animate.** An animation scoped to "whatever changes" animates layout and theme colors nobody meant to animate. **Web:** never `transition: all`; write `transition-property: scale, opacity`.
- **Never scale from `0`.** Nothing in the real world disappears and reappears completely, and an element growing from scale `0` looks like it came out of nowhere. Surfaces start from `0.9` or higher, combined with opacity `0` (the [pattern values](#pattern-values) use `0.95` to `0.97`). Even a barely-visible initial scale makes the entrance feel natural, like a balloon that has a visible shape even when deflated. The one smaller start is an icon in a cross-fade, which runs from `0.25` together with blur and opacity ([icon cross-fade](#icons-cross-fade-on-infrequent-swaps)).
- **Anchor the scale at the trigger** for popovers, dropdowns, menus and tooltips: the transform origin sits where the trigger is. **Modals are exempt**; they are not anchored to a trigger, so they stay centered.
- **Move by the element's own size**, not hardcoded points: a hidden drawer sits one full own-height below its open position, whatever that height is. It adapts to content and is less error-prone.
- **Write per-frame values to the rendered element**, never through the UI framework's state or an inherited variable that every descendant re-reads ([performance](performance.md#keep-per-frame-values-out-of-ui-state)).

## 5. Easing

In decision order:

| Situation | Easing |
| --- | --- |
| Entering or exiting | ease-out (starts fast, feels responsive) |
| Moving or morphing on screen | ease-in-out (natural acceleration and deceleration) |
| Hover or color change | ease |
| Constant motion (marquee, progress bar, hold-to-confirm fill) | linear |
| Default | ease-out |

**Never `ease-in` on UI.** It starts slow, delaying the exact moment the user is watching. A dropdown with `ease-in` at 300ms *feels* slower than `ease-out` at the same 300ms. The reversed path of a transition also exits with ease-out; never mirror an entrance into an ease-in exit.

**Built-in keyword curves are too weak for component motion.** They lack the punch that makes animations feel intentional. Popovers, modals, drawers and on-screen movement take the strong curves:

| Curve | Control points | Use |
| --- | --- | --- |
| **strong ease-out** | `(0.23, 1, 0.32, 1)` | Component open and close, UI enters and exits |
| **strong ease-in-out** | `(0.77, 0, 0.175, 1)` | On-screen movement |
| **drawer** | `(0.32, 0.72, 0, 1)` | iOS-like drawer curve (from Ionic Framework) |
| **icon** | `(0.2, 0, 0, 1)` | The non-spring icon cross-fade |
| keyword ease-out | `(0, 0, 0.58, 1)` | The small patterns that name it |
| keyword ease | `(0.25, 0.1, 0.25, 1)` | The toast and the crossfade mask |

The small, exact patterns keep the values they were tuned with: press feedback (`150ms` keyword ease-out), staged entrances (`300ms` keyword ease-out), subtle exits (`150ms` keyword ease-out), the high-frequency hover (`100ms` keyword ease-out), the icon cross-fade (`300ms` icon curve) and the Sonner-style toast (`400ms` keyword ease). Use them as written ([pattern values](#pattern-values)).

Need a curve that isn't here? Take it from [easing.dev](https://easing.dev/) or [easings.co](https://easings.co/), which list stronger custom variants of the standard easings. Don't hand-roll one.

## 6. Duration

| Element | Duration |
| --- | --- |
| Button press feedback | 100–160ms (the press pattern uses `150ms`) |
| High-frequency hover or state change (opacity, background color only) | `150ms` or less (the row hover uses `100ms`) |
| Tooltips, small popovers | 125–200ms |
| Dropdowns, selects | 150–250ms |
| Modals, drawers | 200–500ms |
| Subtle exit | `150ms` |
| Staged entrance, per chunk | `300ms` |
| Icon cross-fade | `300ms`, or a `0.3` spring |
| Marketing / explanatory | Can be longer |

**UI animations stay at or under 300ms.** A 180ms dropdown feels more responsive than a 400ms one. Anything longer on a UI element needs a stated reason.

### Perceived performance

Speed in animation directly affects how users perceive the app's performance:

- A **fast-spinning spinner** makes loading feel faster, with the same load time.
- A **180ms select** animation feels more responsive than a **400ms** one.
- **Instant tooltips** after the first one is open (skip delay and skip animation) make the whole toolbar feel faster.

The perception of speed matters as much as actual speed. Easing amplifies it: `ease-out` at 200ms *feels* faster than `ease-in` at 200ms, because the user sees immediate movement.

## 7. Springs

Springs feel more natural than duration-based animations because they simulate real physics. They have no fixed duration; they settle based on physical parameters.

Reach for a spring when the motion is:

- a drag with momentum
- an element that should feel alive (Apple's Dynamic Island)
- a gesture the user can interrupt or reverse mid-animation
- decorative mouse-tracking

**Configuration.** A spring is a **duration** and a **bounce**, Apple's form and the easier one to reason about. The duration is the perceptual duration in seconds (Apple calls it *response*: lower is snappier; the spring settles a little after it). The bounce is overshoot: `0` is critically damped, and the damping ratio is `1 − bounce`.

| Spring | Duration | Bounce | Damping ratio | Stiffness (mass 1) |
| --- | --- | --- | --- | --- |
| Default: every state change, entrance, exit | `0.4` | `0` | `1.0` | `247` |
| Momentum release (a flick, a throw, a drag release) | `0.4` | `0.2` | `0.8` | `247` |
| Icon cross-fade | `0.3` | `0` | `1.0` | `439` |

**Bounce is `0`** on every state change, entrance, exit and icon swap. Overshoot on a menu that just faded in feels wrong; overshoot on a card you flicked feels right. Only the release of a gesture that carried momentum may bounce, and then subtly (`0.1`–`0.3`, `0.2` by default). Apple's values per interaction are in [gestures](gestures.md#behavior-over-animation-use-springs).

**Conversion to physics parameters** (unit mass): `stiffness = (2π / duration)²`, `damping = 4π · dampingRatio / duration`. The reverse: `dampingRatio = damping / (2 · √(stiffness · mass))`. So `mass 1, stiffness 100, damping 10` gives `0.5`, a visible bounce, and `damping 20` gives `1`, no overshoot.

| Platform | Spring `(duration d, bounce b)` |
| --- | --- |
| SwiftUI | `.spring(duration: d, bounce: b)`; UIKit `UIView.animate(springDuration: d, bounce: b, …)` |
| Compose | `spring(dampingRatio = 1 − b, stiffness = (2π / d)²)`: the default is `spring(dampingRatio = 1f, stiffness = 247f)` |
| Web (Motion) | `{ type: "spring", bounce: b, duration: d }`; Motion's `duration` measures differently ([web springs](../../platforms/web/motion.md#springs)) |

### Spring-based pointer interactions

Tying a visual change directly to the pointer position feels artificial because it lacks motion. Feed the pointer value into a spring so the visual follows with momentum instead of updating instantly ([web code](../../platforms/web/motion.md#springs)).

This works because the animation is **decorative**: it serves no function. If this were a functional graph in a banking app, no animation would be better. Know when decoration helps and when it hinders. Drive per-frame values like these through the platform's animated values, never through UI state ([performance](performance.md#keep-per-frame-values-out-of-ui-state)).

### Interruptibility advantage

Springs maintain velocity when interrupted; fixed-timeline animations restart from zero. That makes springs ideal for gestures users might change mid-motion. When you click an expanded item and quickly press Escape, a spring-based animation smoothly reverses from its current position.

## 8. Interruption

- **Retargeting transitions, not fixed timelines, for interactive state.** A transition interpolates toward the latest state, so it retargets and reverses mid-flight. A keyframe timeline runs fixed and snaps or restarts from zero. Use transitions (or springs) for hover, toggle, open and close, and anything a user can fire twice in a second, such as toasts being added. Reserve keyframe timelines for sequences that run once, such as enters and loading. **Web:** CSS transitions, not `@keyframes` ([comparison and code](../../platforms/web/motion-recipes.md#interruptible-state-transitions-not-keyframes)).
- **Springs for gestures**, because they carry velocity through an interruption.
- **Never lock out input during a transition**, and always animate from the current on-screen value. Both are covered with the gesture rules in [gestures](gestures.md#interruptibility-the-single-most-important-principle).

## 9. Enter and exit

- **An entering element animates from a defined starting state** (opacity `0`, a slightly smaller scale or a short offset) that the platform applies before the first frame. **Web:** `@starting-style`, with `transition-behavior: allow-discrete` for elements toggled from `display: none` ([web enter and exit](../../platforms/web/motion.md#enter-and-exit)).
- **Exits are shorter and smaller than enters.** Exit content with opacity, `4pt` of blur and a fixed `-12pt` vertical offset over `150ms` with keyword ease-out, never the full container height. Remove the element instantly where motion adds no information ([pattern values](#pattern-values)).
- **Surfaces that travel exit the way they entered.** Slide fully out only where the path carries meaning: a drawer or sheet closing, a toast swiped away, a card returning to its list, a side panel. Those leave along the edge they came from. A toast that slides in from the bottom leaves through the bottom; in-from-right and out-the-bottom feels disconnected. Symmetric paths are what make swipe-to-dismiss feel obvious.
- **Asymmetric timing where the user is deciding.** Slow where the user is deciding, fast where the system responds. A hold-to-confirm press fills over `2s` linear; the release snaps back in `200ms` with strong ease-out.
- **Skip state animations on first appearance.** A state swap (icon swaps, toggles, tabs, segmented controls) shows its default state without animating in on mount. An intentional entrance such as a staggered hero still plays. **Web (React):** `initial={false}` on the `AnimatePresence` around the swap, never around the entrance; Solid keeps both states mounted ([web enter and exit](../../platforms/web/motion.md#enter-and-exit)).
- **The opacity + height pair in entering and exiting lists has no formula.** When items enter and exit a list (like Family's drawer), the opacity change must work with the height animation. It is trial and error; adjust until it feels right.

## 10. Component principles

### Pattern values

The exact values for each known pattern. Implementations under the same names: [web recipes](../../platforms/web/motion-recipes.md) · [Apple](../../platforms/apple/motion.md#patterns) · [Android](../../platforms/android/motion.md#patterns). Every pattern that moves, scales or blurs ships with the [reduced-motion fallback](#reduced-motion-and-pointer-gating).

| Pattern | Animates | From → to | Duration and curve |
| --- | --- | --- | --- |
| Button press | scale | `1` → `0.96`; never while disabled | `150ms` keyword ease-out |
| High-frequency hover (a row) | background color only | | `100ms` keyword ease-out |
| Dropdown, popover, menu, select | opacity, scale from the trigger | `0`, `0.95` → `1`, `1` | `200ms` strong ease-out |
| Tooltip | opacity, scale from the trigger | `0`, `0.97` → `1`, `1` | `125ms` strong ease-out; `0ms` once one is open |
| Modal | opacity, scale from center; the backdrop's opacity with it | `0`, `0.96` → `1`, `1` | `250ms` strong ease-out |
| Unanchored panel shown from hidden | opacity, vertical offset | `0`, `12pt` → `1`, `0` | enter `300ms`, exit `150ms`, keyword ease-out |
| Drawer / sheet | vertical offset by its own height | `100%` → `0` | `500ms` drawer curve |
| Toast | opacity, vertical offset by its own height | `0`, `100%` → `1`, `0` | `400ms` keyword ease |
| Accordion | height (measured), opacity | | `200ms` strong ease-out |
| Staged entrance | per chunk: opacity, blur, vertical offset | `0`, `4pt`, `12pt` → `1`, `0`, `0`; chunks `100ms` apart, headline words `80ms` apart | `300ms` keyword ease-out |
| List or grid stagger | opacity, vertical offset | `0`, `8pt` → `1`, `0`; items `30`–`80ms` apart | `300ms` strong ease-out |
| Subtle exit | opacity, vertical offset, blur | → `0`, `-12pt`, `4pt` | `150ms` keyword ease-out |
| Full exit | opacity, horizontal offset by its own width | → `0`, `-100%` | `200ms` keyword ease-out |
| Icon cross-fade | opacity, scale, blur | `0`, `0.25`, `4pt` ↔ `1`, `1`, `0` | spring `0.3` / bounce `0`, or `300ms` icon curve |
| Hold to confirm | a fill clipped from the trailing side | hidden → full | press `2s` linear; release `200ms` strong ease-out |
| Tab indicator with a color transition | the clip on an active-styled copy of the tab list | follows the active tab | `250ms` strong ease-in-out |
| Scroll reveal (marketing only, once) | a clip from the bottom | hidden → full | `600ms` strong ease-in-out |
| Crossfade mask | blur, opacity on the changing content | → `2pt`, `0.7` | `200ms` keyword ease |
| Reduced-motion fallback | opacity only | | `150ms` keyword ease-out (`300ms` with motion allowed) |

`linear` on the hold-to-confirm fill is deliberate: the fill is a progress indicator, and progress shouldn't ease. The toast's keyword ease and slower timing are deliberate too ([cohesion](#cohesion)).

### Buttons press to 0.96

Any pressable element scales to `0.96` on press, over `150ms` with keyword ease-out. It gives instant feedback that the interface is listening. Scaling the button scales its label and icons too, which is what makes it read as a physical press. A disabled button never scales. Give the button an opt-out where the motion would distract, through the component's existing variant API or a `static` prop.

### Popovers scale from their trigger

Popovers should scale in from their trigger, not from center. A centered transform origin, the default on most platforms, is wrong for almost every popover. **Exception: modals**, which keep a centered origin because they appear centered in the viewport, anchored to no trigger. Whether the user notices the difference individually does not matter. In the aggregate, unseen details become visible.

### Tooltips skip the delay on subsequent hovers

Tooltips delay before appearing to prevent accidental activation. Once one tooltip is open, hovering over adjacent tooltips opens them instantly with no animation. This feels faster without defeating the purpose of the initial delay.

### Blur masks an imperfect crossfade

When a crossfade between two states feels off despite trying different easings and durations, add a subtle `2pt` blur during the transition. Without blur you see two distinct objects overlapping, the old state and the new. Blur bridges the gap by blending them, so the eye perceives a single smooth transformation instead of two objects swapping. Keep animated blur under `20pt`; `2`–`5pt` is enough, and heavy blur is expensive, especially in Safari on the web.

### Icons cross-fade on infrequent swaps

Where an icon swaps on an infrequent state change, such as play to pause or copy to copied, cross-fade it: scale `0.25` to `1`, opacity `0` to `1`, blur `4pt` to `0`. With a spring, use duration `0.3`, bounce `0`; without one, keep both icons mounted and cross-fade over `300ms` with the icon curve. Icon weight, color and direction live in [icons](../icons.md).

| Animate | Don't animate |
| --- | --- |
| Infrequent state swaps such as play to pause, like to liked or copy to copied | Hover-revealed actions in list rows |
| Icons in a toolbar that appears on selection | Tab and navigation icon swaps |
| Loading and success indicators | Decorative or always-visible icons |

### Stagger occasional group entrances

When several elements enter together on a surface the user sees occasionally, stagger them. A cascade feels more natural than everything appearing at once.

- **A staged entrance** (a view's first load, an empty or success state) splits the content into semantic chunks such as title, description and actions, staggered `100ms` apart. Each chunk enters with opacity, `4pt` of blur and `12pt` of vertical offset over `300ms` with keyword ease-out. A short display headline that should read word by word splits into words, `80ms` apart.
- **A list or grid** staggers its items `30`–`80ms` apart, each entering with opacity and `8pt` of vertical offset over `300ms`. Longer delays make the interface feel slow.

Stagger is decorative: never block interaction while it plays, and never stagger routine interactions or a list the user scrolls past all day. The hidden state belongs to the animation, so an item whose animation never runs stays visible.

### Theme switches suppress transitions

Suppress every color transition for the theme swap and restore them once the new theme has rendered. Otherwise every color transition fires at once and the switch smears. **Web:** inject a no-transition style, force a style flush, remove it after the next frame ([recipe](../../platforms/web/motion-recipes.md#suppress-transitions-on-theme-switch)).

## Clip reveals

Animating a rectangular clip region reveals content from one side; each inset eats into the element from that side. It is one of the most powerful animation tools on every platform, and clipping stays on the cheap side of the cost tiers on most renderers. What it unlocks, with values in [pattern values](#pattern-values):

- **Hold to delete**: a colored fill clipped from the trailing side fills to full while the press is held and snaps back on release.
- **Tabs with perfect color transitions**: duplicate the tab list, style the copy as active, clip the copy so only the active tab shows, and animate the clip. The text and background change in perfect sync because one element is being revealed rather than two colors being interpolated. Timing individual color transitions never achieves this. It suits tab lists switched occasionally; app tabs switched tens of times a day stay high-frequency.
- **Image reveals on scroll**: hidden from the bottom to fully shown when the element enters the viewport. Marketing surfaces only, and once: re-animating on every scroll-by is an interface fighting its reader.
- **Comparison sliders**: overlay two images and clip the top one, adjusting the trailing inset from the drag position. No extra elements.

**Web:** `clip-path: inset(…)` ([web clip-path](../../platforms/web/motion.md#clip-path)).

## Reduced motion and pointer gating

Both ship with the animation, every time. The accessibility requirement itself is owned by [motion and zoom](../accessibility/motion-and-zoom.md); the motion side of it is here, and each platform file names its reduced-motion setting and how to read it.

**Reduced motion means fewer and gentler animations, not zero.** Animations can cause motion sickness. Run movement, scale and blur only when the user has not asked for reduced motion. Under reduced motion, replace them with an opacity cross-fade rather than removing the element instantly. Keep opacity and color transitions that aid comprehension; drop elastic overshoot, slides, springs and parallax. In code, branch the transform values on the setting:

```jsx
// Web (React, Motion)
const shouldReduceMotion = useReducedMotion();
const closedX = shouldReduceMotion ? 0 : '-100%';
```

Also, for everyone:

- Avoid full-viewport moving backgrounds and slow looping oscillations (near 0.2 Hz, one cycle per 5s).
- Make large moving objects semi-transparent while they travel, and fade big surfaces out during a large reposition and back in once settled.
- Translucent materials have their own preferences (reduced transparency, increased contrast), covered in [gestures](gestures.md#reduced-transparency-and-contrast).

**Gate hover motion to hover-capable, precise pointers.** Touch devices trigger hover on tap and leave it latched, which reads as a stuck selected state. Press feedback needs no gating, because a press is real on touch.

```css
/* Web */
@media (hover: hover) and (pointer: fine) {
  .element:hover { transform: scale(1.05); }
}
```

**Web:** both conditions matter, and Tailwind's `hover:` gates only part of it ([web hover gating](../../platforms/web/motion.md#reduced-motion-and-hover-gating)).

## Loops and scrolling

- Looping animations pause when off-screen, or the loop unmounts. **Web:** an `IntersectionObserver` toggles `animation-play-state`.
- Scrolling to an in-page target animates, lands clear of any sticky header, and jumps instantly under reduced motion. **Web:** `scroll-behavior: smooth` with `scroll-margin-top`.
- A staggered parent and its children render in the same component tree, or the children mount without the parent's orchestration. **Web (React):** the same client component tree.

## Cohesion

Match motion to the component's personality and the rest of the product. A playful component can be more generous; a professional dashboard should be crisp and fast. Sonner's animation feels satisfying partly because the whole experience is cohesive: its easing and duration fit the vibe of the library. It is slightly slower than typical UI animation and uses keyword ease rather than ease-out to feel more elegant. The motion matches the toast design, the page design and the name. When unsure whether motion feels right, the strongest move is often to delete it.

Designing a component other developers adopt (defaults, naming, invisible edge cases): see [interface judgment](../interface-judgment.md#building-components-people-love).

## Debugging

Each platform file names its tools for these.

- **Slow motion.** Play the animation at reduced speed to spot issues invisible at full speed: temporarily raise the duration 2–5x, or use the platform's slow-animation setting. Look for: colors that show two distinct states overlapping, easing that starts or stops abruptly, the wrong transform origin, and coordinated properties (opacity, transform, color) drifting out of sync.
- **Frame by frame.** Step through the animation. It reveals timing issues between coordinated properties that you cannot see at full speed.
- **Real devices for touch.** Drawers and swipe gestures need real hardware: a simulator or emulator can't reproduce how a flick feels.
- **Fresh eyes the next day.** You notice imperfections the next day that you missed during development.

## When you build

Write the code. Then, in at most a few lines:

- **The gate result**: frequency tier and the named purpose. If something in the request was rejected, say which and why.
- **The ingredients**: tool, properties, curve, duration or spring config, one line each.
- **What to feel-check**: if the result depends on feel you can't judge from code (a crossfade, a spring's bounce, the opacity/height balance in an entering list), say so and point at the check from [Debugging](#debugging).

Don't pad this into a report; the code is the deliverable. When the honest answer is "this shouldn't animate", give it. When feel genuinely can't be settled from code, say so instead of guessing at a value. Before finishing, self-check against the [detection checklist](standards.md#detection-checklist) and your platform's detection rows: each row is an automatic block in a motion review.

## Files in this domain

| File | Read when |
| --- | --- |
| [standards.md](standards.md) | Reviewing motion, or checking work before handoff: the ten standards, detection checklist, remedial order, severity and approval criteria |
| [performance.md](performance.md) | An animation stutters or drops frames; choosing a property; where animation runs; per-frame values |
| [gestures.md](gestures.md) | Drag, swipe, sheets, momentum, velocity handoff, rubber-banding, Apple-style springs, translucent materials and depth |
| [vocabulary.md](vocabulary.md) | Someone describes an effect without knowing its name |
| [Web motion](../../platforms/web/motion.md), [recipes](../../platforms/web/motion-recipes.md), [performance](../../platforms/web/motion-performance.md) | Building motion in CSS, React (`motion/react`) or Solid |
| [Apple motion](../../platforms/apple/motion.md) | Building motion in SwiftUI, UIKit or AppKit |
| [Android motion](../../platforms/android/motion.md) | Building motion in Jetpack Compose |

Workflows that apply this domain: [motion review](../../workflows/motion-review.md) for a diff or component, [motion audit](../../workflows/motion-audit.md) for a codebase-wide plan, [motion opportunities](../../workflows/motion-opportunities.md) to find what should and shouldn't animate.
