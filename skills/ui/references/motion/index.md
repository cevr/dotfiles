# Motion

Whether to animate, what for, and with which ingredients: frequency, purpose, tool, properties, easing, duration, springs, interruption, enter and exit, component principles, reduced motion and debugging. The build sequence below is the order the decisions are made in. Each step gates the next, so a curve is never chosen before the motion has earned the right to exist.

Read this file before writing or changing any animation. The sub-files at the end hold copy-paste recipes, the review bar, performance diagnosis, gestures and the glossary.

## Why the craft matters

**Taste is trained, not innate.** Good taste is not personal preference. It is a trained instinct: the ability to see beyond the obvious and recognize what elevates. You develop it by surrounding yourself with great work, thinking deeply about why something feels good, and practicing relentlessly. Don't just make it work. Study why the best interfaces feel the way they do. Reverse engineer animations. Inspect interactions.

**Unseen details compound.** Most details users never consciously notice. That is the point. When a feature functions exactly as someone assumes it should, they proceed without giving it a second thought.

> "All those unseen details combine to produce something that's just stunning, like a thousand barely audible voices all singing in tune." - Paul Graham

**Beauty is leverage.** People select tools based on the overall experience, not just functionality. Good defaults and good animations are real differentiators.

**Polish never outranks a broken interaction.** Motion polish applies once the underlying interaction is sound. A motion finding never outranks a broken interaction.

## Hard rules

1. **Run the sequence in order.** Steps 1 and 2 gate everything. Don't reach for a curve before you know whether it animates at all.
2. **Values are exact, not ranges to approximate.** Every curve, duration and spring config comes from the tables below or from [recipes.md](recipes.md). `cubic-bezier(0.2, 0, 0, 1)` is not `cubic-bezier(0.4, 0, 0.2, 1)`, and `0.96` is not `0.95`. Never invent a curve because it looks familiar.
3. **Extend the codebase's tokens, don't fork them.** If `--ease-out` or a duration scale already exists, use it. Adding a parallel system is a defect. Match the project's motion language wherever no rule here gives a value. A deliberate and consistent project convention is a preference, not a finding. The same detail done two ways within the project is a finding.
4. **Reduced motion and hover gating ship with the animation**, not as a follow-up.
5. **Cheapest tool that works.** Don't install a motion library for a fade.
6. **Motion is never the only feedback channel.** Every animated state change also leaves a static cue in the form of a color, icon or label.

Two failure modes, and the first is worse:

1. **Animating something that shouldn't animate.** The gate below exists to produce zero lines of code sometimes. That's a success, not a dodge.
2. **Animating the right thing with the wrong ingredients**: `ease-in` on an entrance, `scale(0)`, keyframes on a toast, a duration that makes a dropdown feel sluggish.

Never present motion options as a menu. Make the call, state the reasoning in one line, write the code.

## 1. Should this animate at all?

Ask how often a user will see it.

| Frequency | Decision |
| --- | --- |
| 100+ times/day (keyboard shortcuts, command palette toggle, core navigation, focus jumps) | **No animation. Ever.** Stop here. |
| Tens of times/day (hover effects, row hovers, list navigation, tab switches, frequent toggles, keystroke feedback) | Instant feedback, or a transition of `150ms` or less on `opacity` or `background-color` only. Nothing expressive. |
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

Walk down; stop at the first that fits.

| Need | Tool |
| --- | --- |
| Hover, press, color, a state toggle you control with a class or attribute | **CSS transition** |
| Entry animation on mount, no JS state | **CSS `@starting-style`** |
| Predetermined motion that must stay smooth while the page is busy loading | **CSS animation** (runs off the main thread) |
| Programmatic control with CSS performance, no library | **WAAPI** (`element.animate()`) |
| Springs, layout animations, exit animations for unmounted components, gesture-driven values | **Motion** (`motion.dev`) |

CSS animations beat JS under load: they can run off the main thread, while `requestAnimationFrame`-based animation drops frames while the browser loads, scripts or paints. Use CSS for predetermined motion and JS for dynamic, interruptible motion. The thread model and the exceptions are in [performance.md](performance.md#where-it-runs).

With a motion library in React, import from `"motion/react"` when `motion` is installed, or `"framer-motion"` when that is. Where both exist, follow the imports the component or its nearest peers already use. Solid uses the framework-agnostic `motion` exports ([solid.md](../../platforms/web/solid.md#5-motion)).

If the task needs a *component* rather than an animation (a toast, a drawer, a command menu, a dropdown), stop and get it from the project's components: in React the `shadcn` skill (installed components, then registry search), in Solid the primitive package. Hand-rolling those is how you end up with a `<div>` dropdown and no focus management.

## 4. Pick the properties

- **`transform` and `opacity` by default.** They skip layout and paint and run on the GPU. `width`, `height`, `margin`, `padding`, `top` and `left` trigger all three rendering steps. `clip-path` is the sanctioned extra (see [clip-path](#clip-path-for-animation)), `filter: blur()` is fine under `20px`, and `height` is tolerated only for accordions, where there is no transform equivalent. The full cost tiers and cheaper swaps are in [performance.md](performance.md#what-you-animate).
- **Never `transition: all`.** Name the exact properties, as in `transition-property: scale, opacity`. `all` animates whatever changes next, including layout properties and theme colors nobody meant to animate.
- **Never `scale(0)`.** Nothing in the real world disappears and reappears completely, and an element growing from `scale(0)` looks like it came out of nowhere. Surfaces start from `scale(0.9)` or higher, combined with `opacity: 0` (the recipes use `0.95` to `0.97`). Even a barely-visible initial scale makes the entrance feel natural, like a balloon that has a visible shape even when deflated. The one smaller start is an icon in a cross-fade, which runs from `0.25` together with blur and opacity ([Icon cross-fade](recipes.md#icon-cross-fade)).
- **`transform-origin` at the trigger** for popovers, dropdowns, menus and tooltips: `var(--transform-origin)` in Base UI. **Modals are exempt**; they are not anchored to a trigger, so they stay centered.
- **Percentages in `translate()`** are relative to the element's own size. Prefer them over hardcoded pixels ([transforms](#css-transforms)).
- **Motion's `x`/`y`/`scale` shorthands** run on the main thread. Keep them by default and switch to the full `transform` string when the animation must survive a busy main thread ([performance.md](performance.md#where-it-runs)).
- **Never drive a child's transform from a CSS variable on the parent.** It recalculates styles for every child. Set `transform` on the element directly ([performance.md](performance.md#two-traps-that-look-correct)).

## 5. Easing

In decision order:

| Situation | Easing |
| --- | --- |
| Entering or exiting | `ease-out` (starts fast, feels responsive) |
| Moving or morphing on screen | `ease-in-out` (natural acceleration and deceleration) |
| Hover or color change | `ease` |
| Constant motion (marquee, progress bar, hold-to-confirm fill) | `linear` |
| Default | `ease-out` |

**Never `ease-in` on UI.** It starts slow, delaying the exact moment the user is watching. A dropdown with `ease-in` at 300ms *feels* slower than `ease-out` at the same 300ms. The reversed path of a transition also exits with `ease-out`; never mirror an entrance into an `ease-in` exit.

**Built-in CSS easings are too weak for component motion.** They lack the punch that makes animations feel intentional. Popovers, modals, drawers and on-screen movement take these curves:

```css
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);        /* strong ease-out for UI */
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);    /* strong ease-in-out for on-screen movement */
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);     /* iOS-like drawer curve (from Ionic Framework) */
```

The small, exact recipes keep the values they were tuned with: press feedback (`150ms ease-out`), staged entrances (`300ms ease-out`), subtle exits (`150ms ease-out`), the high-frequency hover (`100ms ease-out`), the CSS icon cross-fade (`300ms cubic-bezier(0.2, 0, 0, 1)`) and the Sonner-style toast (`400ms ease`). Use them as written.

Need a curve that isn't here? Take it from [easing.dev](https://easing.dev/) or [easings.co](https://easings.co/), which list stronger custom variants of the standard easings. Don't hand-roll one.

## 6. Duration

| Element | Duration |
| --- | --- |
| Button press feedback | 100–160ms (the press recipe uses `150ms`) |
| High-frequency hover or state change (`opacity`, `background-color` only) | `150ms` or less (the row hover uses `100ms`) |
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

**Configuration.** Motion's `bounce` + `duration` form maps closely to Apple's damping ratio + response and is the easier one to reason about:

```js
{ type: "spring", bounce: 0, duration: 0.4 }    // default: critically damped, no overshoot
{ type: "spring", bounce: 0.2, duration: 0.4 }  // only after a momentum gesture (a flick, a throw, a drag release)
{ type: "spring", duration: 0.3, bounce: 0 }    // icon cross-fade
```

**Bounce is `0`** on every state change, entrance, exit and icon swap. Overshoot on a menu that just faded in feels wrong; overshoot on a card you flicked feels right. Only the release of a gesture that carried momentum may bounce, and then subtly (`0.1`–`0.3`, `0.2` by default). Apple's damping/response values per interaction are in [gestures.md](gestures.md#behavior-over-animation-use-springs).

The traditional physics form gives more control:

```js
{ type: "spring", mass: 1, stiffness: 100, damping: 10 }
```

Its damping ratio is `damping / (2 * Math.sqrt(stiffness * mass))`, so these values give `0.5`, a visible bounce. A ratio of `1` (here, `damping: 20`) settles without overshoot.

### Spring-based mouse interactions

Tying visual changes directly to mouse position feels artificial because it lacks motion. Use `useSpring` from Motion to interpolate value changes with spring-like behavior instead of updating immediately:

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

This works because the animation is **decorative**: it serves no function. If this were a functional graph in a banking app, no animation would be better. Know when decoration helps and when it hinders. Drive per-frame values like these through motion values, never through React state ([performance.md](performance.md#react-dont-animate-through-state)).

### Interruptibility advantage

Springs maintain velocity when interrupted; CSS keyframes restart from zero. That makes springs ideal for gestures users might change mid-motion. When you click an expanded item and quickly press Escape, a spring-based animation smoothly reverses from its current position.

## 8. Interruption

- **Transitions, not keyframes, for interactive state.** CSS transitions interpolate toward the latest state, so they retarget and reverse mid-flight. Keyframes run a fixed timeline and snap or restart from zero. Use transitions (or a library's springs) for hover, toggle, open and close, and anything a user can fire twice in a second, such as toasts being added. Reserve keyframes for sequences that run once, such as enters and loading. The comparison and code are in [recipes.md](recipes.md#interruptible-state-transitions-not-keyframes).
- **Springs for gestures**, because they carry velocity through an interruption.
- **Never lock out input during a transition**, and always animate from the current on-screen value. Both are covered with the gesture rules in [gestures.md](gestures.md#interruptibility-the-single-most-important-principle).

## 9. Enter and exit

- **`@starting-style` animates entry without JavaScript.** It replaces the React pattern of a `useEffect` that sets `mounted: true` after the first render. Use it when browser support allows (Baseline 2024), and fall back to the `data-mounted` attribute pattern otherwise. Elements toggled from `display: none` also need `transition-behavior: allow-discrete` ([recipe](recipes.md#entering-from-display-none)).
- **Exits are shorter and smaller than enters.** Exit content with `opacity`, `4px` of blur and a fixed `-12px` `translateY` over `150ms` with `ease-out`, never the full container height. Remove the element instantly where motion adds no information ([recipes](recipes.md#exits)).
- **Surfaces that travel exit the way they entered.** Slide fully out only where the path carries meaning: a drawer or sheet closing, a toast swiped away, a card returning to its list, a side panel. Those leave along the edge they came from. A toast that slides in from the bottom leaves through the bottom; in-from-right and out-the-bottom feels disconnected. Symmetric paths are what make swipe-to-dismiss feel obvious.
- **Asymmetric timing where the user is deciding.** Slow where the user is deciding, fast where the system responds. A hold-to-confirm press fills over `2s linear`; the release snaps back in `200ms ease-out`.
- **Skip state animations on first render.** In React, set `initial={false}` on an `AnimatePresence` that wraps a state swap (icon swaps, toggles, tabs, segmented controls), so the default state does not animate in on mount. Never set it around an intentional entrance such as a staggered hero ([recipe](recipes.md#skip-animation-on-page-load)). In Solid, keep both states mounted and let CSS swap them, so nothing animates at mount ([solid.md](../../platforms/web/solid.md#5-motion)).
- **The opacity + height pair in entering and exiting lists has no formula.** When items enter and exit a list (like Family's drawer), the opacity change must work with the height animation. It is trial and error; adjust until it feels right.

## 10. Component principles

### Buttons press to 0.96

Any pressable element scales to `0.96` on press, over `150ms` with `ease-out`. It gives instant feedback that the interface is listening. `scale()` scales the label and icons too, which is what makes it read as a physical press. A disabled button never scales. Give the button an opt-out where the motion would distract, through the component's existing variant API or a `static` prop. Recipes for CSS, Tailwind and Motion are in [recipes.md](recipes.md#button-press).

### Popovers scale from their trigger

Popovers should scale in from their trigger, not from center. The default `transform-origin: center` is wrong for almost every popover. **Exception: modals**, which keep `transform-origin: center` because they appear centered in the viewport, anchored to no trigger. Whether the user notices the difference individually does not matter. In the aggregate, unseen details become visible ([recipe](recipes.md#dropdown-popover-menu-select)).

### Tooltips skip the delay on subsequent hovers

Tooltips delay before appearing to prevent accidental activation. Once one tooltip is open, hovering over adjacent tooltips opens them instantly with no animation. This feels faster without defeating the purpose of the initial delay ([recipe](recipes.md#tooltip)).

### Blur masks an imperfect crossfade

When a crossfade between two states feels off despite trying different easings and durations, add a subtle `filter: blur(2px)` during the transition. Without blur you see two distinct objects overlapping, the old state and the new. Blur bridges the gap by blending them, so the eye perceives a single smooth transformation instead of two objects swapping. Keep animated blur under `20px`; `2`–`5px` is enough, and heavy blur is expensive, especially in Safari ([recipe](recipes.md#masking-a-crossfade-that-wont-settle)).

### Icons cross-fade on infrequent swaps

Where an icon swaps on an infrequent state change, such as play to pause or copy to copied, cross-fade it: scale `0.25` to `1`, opacity `0` to `1`, blur `4px` to `0px`. With a motion library use `{ type: "spring", duration: 0.3, bounce: 0 }`. Without one, keep both icons in the DOM and cross-fade over `300ms` with `cubic-bezier(0.2, 0, 0, 1)`. A tab's icon swap and the actions a row reveals on hover are high-frequency and get no animation ([recipes and the which-icons table](recipes.md#icon-cross-fade)).

### Stagger occasional group entrances

When several elements enter together on a surface the user sees occasionally, stagger them. A cascade feels more natural than everything appearing at once.

- **A staged entrance** (a view's first load, an empty or success state) splits the content into semantic chunks such as title, description and actions, staggered `100ms` apart. Each chunk enters with opacity, `4px` of blur and `12px` of `translateY` over `300ms` with `ease-out`. A short display headline that should read word by word splits into words, `80ms` apart.
- **A list or grid** staggers its items `30`–`80ms` apart, each entering with opacity and `8px` of `translateY` over `300ms`. Longer delays make the interface feel slow.

Stagger is decorative: never block interaction while it plays, and never stagger routine interactions or a list the user scrolls past all day ([recipes](recipes.md#staged-entrance)).

### Theme switches suppress transitions

Disable every transition for the theme swap, force a style flush and restore transitions after the next frame. Otherwise every color transition fires at once and the switch smears ([recipe](recipes.md#suppress-transitions-on-theme-switch)).

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

## clip-path for animation

`clip-path` is not just for shapes; it is one of the most powerful animation tools in CSS. `clip-path: inset(top right bottom left)` defines a rectangular clipping region, and each value "eats" into the element from that side:

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

What it unlocks, each with a recipe in [recipes.md](recipes.md):

- **Hold to delete**: a colored overlay clipped with `inset(0 100% 0 0)` fills to `inset(0 0 0 0)` over `2s linear` on `:active` and snaps back in `200ms ease-out` on release ([recipe](recipes.md#hold-to-confirm)).
- **Tabs with perfect color transitions**: duplicate the tab list, style the copy as active, clip the copy so only the active tab shows, and animate the clip. Timing individual color transitions never achieves this. It suits tab lists switched occasionally; app tabs switched tens of times a day stay high-frequency ([recipe](recipes.md#tab-indicator-with-a-color-transition)).
- **Image reveals on scroll**: `inset(0 0 100% 0)` (hidden from the bottom) to `inset(0 0 0 0)` when the element enters the viewport ([recipe](recipes.md#scroll-reveal)).
- **Comparison sliders**: overlay two images and clip the top one with `clip-path: inset(0 50% 0 0)`, adjusting the right inset from the drag position. No extra DOM elements, fully hardware-accelerated where the browser composites `clip-path`.

## Reduced motion and pointer gating

Both ship with the animation, every time. The accessibility requirement itself is owned by [motion and zoom](../accessibility/motion-and-zoom.md); the motion side of it is here.

**Reduced motion means fewer and gentler animations, not zero.** Animations can cause motion sickness. Run movement, scale and blur only under `prefers-reduced-motion: no-preference`. Under reduced motion, replace them with an opacity cross-fade rather than removing the element instantly. Keep opacity and color transitions that aid comprehension; drop elastic overshoot, slides, springs and parallax. Recipes for CSS, Tailwind and Motion are in [recipes.md](recipes.md#reduced-motion-fallback). In JS, branch transform values:

```jsx
const shouldReduceMotion = useReducedMotion();
const closedX = shouldReduceMotion ? 0 : '-100%';
```

Also, for everyone:

- Avoid full-viewport moving backgrounds and slow looping oscillations (near 0.2 Hz, one cycle per 5s).
- Make large moving objects semi-transparent while they travel, and fade big surfaces out during a large reposition and back in once settled.
- Translucent materials have their own preferences (`prefers-reduced-transparency`, `prefers-contrast`), covered in [gestures.md](gestures.md#reduced-transparency-and-contrast).

**Gate hover motion to hover-capable, precise pointers.** Touch devices trigger hover on tap and leave `:hover` latched, which reads as a stuck selected state:

```css
@media (hover: hover) and (pointer: fine) {
  .element:hover {
    transform: scale(1.05);
  }
}
```

Both conditions matter: `(pointer: fine)` rules out styluses and the odd Android device that claims hover support. Tailwind 4's `hover:` variant compiles under `@media (hover: hover)` only (the hover half); Tailwind 3's compiles under no query unless `future.hoverOnlyWhenSupported` is set. Press feedback on `:active` needs no gating, because a press is real on touch. The rest of the touch fixes (tap highlight, tap delay, sticky hover) are in [mobile web](../../platforms/web/mobile.md).

## Loops and scrolling

- Looping animations pause when off-screen: an `IntersectionObserver` toggles `animation-play-state`, or the loop unmounts.
- In-page anchors use `scroll-behavior: smooth`, with `scroll-margin-top` clearing any sticky header; drop the smoothing under reduced motion.
- A staggered parent and its children render in the same client component tree, or the children mount without the parent's orchestration.

## Cohesion

Match motion to the component's personality and the rest of the product. A playful component can be more generous; a professional dashboard should be crisp and fast. Sonner's animation feels satisfying partly because the whole experience is cohesive: its easing and duration fit the vibe of the library. It is slightly slower than typical UI animation and uses `ease` rather than `ease-out` to feel more elegant. The motion matches the toast design, the page design and the name. When unsure whether motion feels right, the strongest move is often to delete it.

Designing a component other developers adopt (defaults, naming, invisible edge cases): see [interface judgment](../interface-judgment.md#building-components-people-love).

## Debugging

- **Slow motion.** Play the animation at reduced speed to spot issues invisible at full speed: temporarily raise the duration 2–5x, or set playback to 10% in the browser's Animations panel. Look for: colors that show two distinct states overlapping, easing that starts or stops abruptly, the wrong `transform-origin`, and coordinated properties (opacity, transform, color) drifting out of sync.
- **Frame by frame.** Step through in the Chrome DevTools Animations panel. It reveals timing issues between coordinated properties that you cannot see at full speed.
- **Real devices for touch.** For drawers and swipe gestures, connect a phone over USB, open the dev server by IP address and use Safari's remote devtools. The Xcode Simulator is an alternative, but real hardware is better for gesture testing ([mobile web](../../platforms/web/mobile.md)).
- **Fresh eyes the next day.** You notice imperfections the next day that you missed during development.

## When you build

Write the code. Then, in at most a few lines:

- **The gate result**: frequency tier and the named purpose. If something in the request was rejected, say which and why.
- **The ingredients**: tool, properties, curve, duration or spring config, one line each.
- **What to feel-check**: if the result depends on feel you can't judge from code (a crossfade, a spring's bounce, the opacity/height balance in an entering list), say so and point at the check from [Debugging](#debugging).

Don't pad this into a report; the code is the deliverable. When the honest answer is "this shouldn't animate", give it. When feel genuinely can't be settled from code, say so instead of guessing at a value. Before finishing, self-check against the [detection checklist](standards.md#detection-checklist): each row is an automatic block in a motion review.

## Files in this domain

| File | Read when |
| --- | --- |
| [recipes.md](recipes.md) | Building a known component or effect: button press, dropdown, tooltip, modal, drawer, toast, accordion, staged entrance, list stagger, exits, icon cross-fade, hold-to-confirm, tab indicator, scroll reveal, crossfade blur, theme switch, reduced-motion fallback, WAAPI |
| [standards.md](standards.md) | Reviewing motion, or checking work before handoff: the ten standards, detection checklist, remedial order, severity and approval criteria |
| [performance.md](performance.md) | An animation stutters or drops frames; choosing a property; CSS vs WAAPI vs rAF; `will-change`; React per-frame renders |
| [gestures.md](gestures.md) | Drag, swipe, sheets, momentum, velocity handoff, rubber-banding, Apple-style springs, translucent materials and depth |
| [vocabulary.md](vocabulary.md) | Someone describes an effect without knowing its name |

Workflows that apply this domain: [motion review](../../workflows/motion-review.md) for a diff or component, [motion audit](../../workflows/motion-audit.md) for a codebase-wide plan, [motion opportunities](../../workflows/motion-opportunities.md) to find what should and shouldn't animate.
