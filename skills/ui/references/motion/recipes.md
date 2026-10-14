# Motion recipes

Ready-to-build implementations for the cases that come up most. Start from the recipe, then adapt; don't rebuild from scratch. Every value here is exact. The rules behind them, and when each one is allowed at all, are in [motion](index.md).

Curves are the `--ease-out`, `--ease-in-out` and `--ease-drawer` tokens defined in [motion easing](index.md#5-easing). Recipes that name a keyword (`ease-out`, `ease`) use it as written.

Every recipe that moves, scales or blurs ships with the [reduced-motion fallback](#reduced-motion-fallback). Drag-driven recipes (drag to dismiss, sheets with momentum) live in [gestures.md](gestures.md#drag-to-dismiss).

## Interruptible state: transitions, not keyframes

| | CSS transitions | CSS keyframe animations |
| --- | --- | --- |
| **Behavior** | Interpolate toward the latest state | Run on a fixed timeline |
| **Interrupted** | Retarget mid-flight and reverse | Snap or restart from the beginning |
| **Use for** | Hover, toggle, open and close | Sequences that run once, such as enters and loading |

```css
/* Good: clicking again mid-animation reverses smoothly */
.drawer {
  transform: translateX(-100%);
  transition: transform 200ms ease-out;
}
.drawer.open {
  transform: translateX(0);
}

/* Bad: closing mid-animation snaps */
.drawer.open {
  animation: slideIn 200ms ease-out forwards;
}
```

The same holds for anything triggered rapidly, such as toasts being added:

```css
/* Interruptible: good for dynamic UI */
.toast {
  transition: transform 400ms ease;
}

/* Not interruptible: avoid for dynamic UI */
@keyframes slideIn {
  from {
    transform: translateY(100%);
  }
  to {
    transform: translateY(0);
  }
}
```

## Button press

Any pressable element. Instant feedback that the interface heard the user.

```css
.button {
  transition-property: scale;
  transition-duration: 150ms;
  transition-timing-function: ease-out;
}

.button:not(:disabled):active {
  scale: 0.96;
}
```

```tsx
// Tailwind
<button className="transition-transform duration-150 ease-out enabled:active:scale-[0.96]">
  Click me
</button>

// Motion
<motion.button whileTap={disabled ? undefined : { scale: 0.96 }} disabled={disabled}>
  Click me
</motion.button>
```

`scale` scales children too: the label and icons come along, which is what makes it read as a physical press. No hover gating is needed: `:active` is a real press on touch. Gate any `:hover` styling separately.

### Static prop pattern

Where the button has no variant API to carry the opt-out, apply the scale class conditionally on a `static` prop:

```tsx
const tapScale = "enabled:active:scale-[0.96]";

function Button({ static: isStatic, className, children, ...props }) {
  return (
    <button
      className={cn(
        "transition-transform duration-150 ease-out",
        !isStatic && tapScale,
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

// Usage
<Button>Click me</Button>           {/* scales on press */}
<Button static>Submit</Button>       {/* no scale */}
```

## High-frequency hover

```css
/* Good: high-frequency hover gets a minimal transition */
.row:hover {
  background-color: var(--surface-hover);
  transition: background-color 100ms ease-out;
}

/* Bad: every hover replays a full entrance */
.row:hover .row-icon {
  animation: bounceIn 500ms;
}
```

## Dropdown, popover, menu, select

Scales out of its trigger, not out of thin air.

```css
.popover {
  transform-origin: var(--transform-origin); /* Base UI supplies this */
  transition:
    opacity 200ms var(--ease-out),
    transform 200ms var(--ease-out);
}

.popover[data-starting-style],
.popover[data-ending-style] {
  opacity: 0;
  transform: scale(0.95);
}
```

The `transform-origin` is the whole point: the panel should look like it came out of the thing you clicked.

## Tooltip

Same shape as a popover, faster, plus the detail most implementations miss.

```css
.tooltip {
  transform-origin: var(--transform-origin);
  transition:
    transform 125ms var(--ease-out),
    opacity 125ms var(--ease-out);
}

.tooltip[data-starting-style],
.tooltip[data-ending-style] {
  opacity: 0;
  transform: scale(0.97);
}

/* Once one tooltip is open, neighbours open instantly */
.tooltip[data-instant] {
  transition-duration: 0ms;
}
```

The initial delay prevents accidental activation. After that, skipping both the delay and the animation makes the whole toolbar feel faster.

## Modal

The one popover that stays centered.

```css
.modal {
  transform-origin: center; /* exempt: not anchored to a trigger */
  transition:
    opacity 250ms var(--ease-out),
    transform 250ms var(--ease-out);
}

.modal[data-starting-style],
.modal[data-ending-style] {
  opacity: 0;
  transform: scale(0.96);
}

.backdrop {
  transition: opacity 250ms var(--ease-out);
}
```

Animate the backdrop's opacity alongside it so they read as one surface.

## Entering from display: none

A popover, dialog or element toggled from `display: none` has no previous style to transition from. `@starting-style` supplies one, and `transition-behavior: allow-discrete` keeps it rendered through the exit. The open state's duration applies on enter and the closed state's on exit.

```css
[popover] {
  opacity: 0;
  translate: 0 12px;
  transition-property: opacity, translate, display, overlay;
  transition-duration: 150ms;
  transition-timing-function: ease-out;
  transition-behavior: allow-discrete;
}

[popover]:popover-open {
  opacity: 1;
  translate: 0 0;
  transition-duration: 300ms;
}

@starting-style {
  [popover]:popover-open {
    opacity: 0;
    translate: 0 12px;
  }
}
```

`@starting-style` and discrete `display` transitions are Baseline 2024. `overlay` is Chromium only, and browsers without support show and hide instantly.

These values suit an unanchored panel. A popover anchored to a trigger keeps this mechanism (`@starting-style`, `allow-discrete`, `display` and `overlay` in the transition) but takes the origin-aware values from [Dropdown, popover, menu, select](#dropdown-popover-menu-select).

## Drawer / sheet

```css
.drawer {
  transform: translateY(0);
  transition: transform 500ms var(--ease-drawer);
}

.drawer[data-closed] {
  transform: translateY(100%);
}
```

This is how Vaul hides a drawer before animating it in. A drawer closing is a full exit: it leaves along the edge it came from.

Add drag and it becomes a gesture problem; see [drag to dismiss](gestures.md#drag-to-dismiss).

## Toast

```css
.toast {
  opacity: 1;
  transform: translateY(0);
  transition:
    opacity 400ms ease,
    transform 400ms ease;

  @starting-style {
    opacity: 0;
    transform: translateY(100%);
  }
}
```

- `ease` rather than `ease-out`, slightly slower than typical UI: Sonner reads as elegant partly because its motion is tuned to the component's personality rather than to the generic UI budget.
- A toast exits through the edge it entered, which is what makes swipe-to-dismiss feel obvious.
- If `@starting-style` isn't available, fall back to the mount flag:

```jsx
useEffect(() => { setMounted(true); }, []);
// <div data-mounted={mounted}>
```

When toasts stack and the list reflows, the opacity change has to work against the height change. There's no formula for that pair: adjust until it feels right, then check it again the next day. For the Sonner library itself, see [Sonner](../sonner.md).

## Accordion / collapse

```css
.content {
  overflow: hidden;
  transition:
    height 200ms var(--ease-out),
    opacity 200ms var(--ease-out);
}
```

Keep it short: this is one of the few animations that costs layout on every frame, so a long duration is expensive as well as sluggish. Measure the content height in JS (or use a headless primitive that supplies it) rather than animating to `auto`.

## Staged entrance

For a view's first load, an empty state or a success state, where sequence communicates hierarchy.

1. **Split** into semantic groups such as title, description and actions.
2. **Stagger** the groups `100ms` apart.
3. **Split a short display headline** into words, staggered `80ms` apart, where it should read word by word.
4. **Combine** `opacity`, `blur` and `translateY` for each group's enter.

### Motion

```tsx
const item = {
  hidden: { opacity: 0, y: 12, filter: "blur(4px)" },
  visible: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: 0.3, ease: "easeOut" },
  },
};

function PageHeader() {
  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={{ visible: { transition: { staggerChildren: 0.1 } } }}
    >
      <motion.h1 variants={item}>Welcome</motion.h1>
      <motion.p variants={item}>A description of the page.</motion.p>
      <motion.div variants={item}>
        <Button>Get started</Button>
      </motion.div>
    </motion.div>
  );
}
```

Under `<MotionConfig reducedMotion="user">` the `y` drops out, but the blur still runs; branch the `filter` on `useReducedMotion()` (see [Reduced-motion fallback](#reduced-motion-fallback)).

### CSS

The hidden state lives in the `from` keyframe, so an item whose animation never runs stays visible. Reduced motion keeps only the opacity keyframe.

```css
.stagger-item {
  animation: fade-in 300ms ease-out both;
}

@media (prefers-reduced-motion: no-preference) {
  .stagger-item {
    animation-name: fade-in-up;
  }
}

.stagger-item:nth-child(2) { animation-delay: 100ms; }
.stagger-item:nth-child(3) { animation-delay: 200ms; }

@keyframes fade-in {
  from { opacity: 0; }
}

@keyframes fade-in-up {
  from {
    opacity: 0;
    transform: translateY(12px);
    filter: blur(4px);
  }
}
```

## List and grid stagger

For a list or grid the user sees occasionally, not for a list they scroll past all day. Items stagger `30`–`80ms` apart; longer delays feel slow. Same structure as the staged entrance, so the hidden state lives in the keyframe and a skipped animation leaves the item visible:

```css
.item {
  animation: fade-in 300ms var(--ease-out) both;
}

@media (prefers-reduced-motion: no-preference) {
  .item {
    animation-name: item-in;
  }
}

.item:nth-child(2) { animation-delay: 50ms; }
.item:nth-child(3) { animation-delay: 100ms; }
.item:nth-child(4) { animation-delay: 150ms; }

@keyframes fade-in {
  from { opacity: 0; }
}

@keyframes item-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}
```

Stagger is decorative: it must never block interaction while it plays.

## Exits

Exits are shorter and smaller than enters.

### Subtle exit

```tsx
<motion.div
  exit={{
    opacity: 0,
    y: -12,
    filter: "blur(4px)",
    transition: { duration: 0.15, ease: "easeOut" },
  }}
>
  {content}
</motion.div>
```

### Full exit

Slide fully out only where the destination carries meaning, such as a card returning to a list or a drawer closing:

```tsx
<motion.div
  exit={{
    opacity: 0,
    x: "-100%",
    transition: { duration: 0.2, ease: "easeOut" },
  }}
>
  {content}
</motion.div>
```

### Good and bad

```css
/* Good: subtle exit */
.item-exit {
  opacity: 0;
  transform: translateY(-12px);
  transition: opacity 150ms ease-out, transform 150ms ease-out;
}

/* Bad: dramatic exit that steals focus */
.item-exit {
  opacity: 0;
  transform: translateY(-100%) scale(0.5);
  transition: all 400ms ease-out;
}

/* Sometimes correct: remove at once when motion adds no information */
.item-exit {
  display: none;
}
```

## Skip animation on page load

`initial={false}` on `AnimatePresence` keeps a component's default state from animating in on mount. The [icon cross-fade](#icon-cross-fade-with-motion) uses it correctly. It suits icon swaps, toggles, tabs and segmented controls, anything with a default state on page load.

Setting it around a first-time entrance skips that entrance entirely. Check the component on a full page refresh before adding it.

```tsx
// Bad: initial={false} skips the staggered page enter
<AnimatePresence initial={false}>
  <motion.div initial="hidden" animate="visible" variants={...}>
    ...
  </motion.div>
</AnimatePresence>
```

## Icon cross-fade

For an icon that swaps on an infrequent state change. Icon weight, color and direction live in [icons](../icons.md).

Check the project's `package.json` and pick the import as in [motion tool choice](index.md#3-pick-the-tool-cheapest-that-works). Where neither `motion` nor `framer-motion` is present, use the CSS cross-fade and never add a dependency just for icon transitions.

### Icon cross-fade with Motion

```tsx
import { AnimatePresence, motion } from "motion/react";

function IconButton({ isActive, icon: Icon }) {
  return (
    <button>
      <AnimatePresence initial={false} mode="popLayout">
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

`initial={false}` keeps the default icon from animating in on mount.

### Icon cross-fade in CSS, both icons in the DOM

Both icons stay mounted in one grid cell, so enter and exit both animate and the larger icon sets the size. The `motion-reduce:` classes leave only the opacity fade under reduced motion.

```tsx
const layer = cn(
  "[grid-area:1/1] transition-[opacity,filter,scale] duration-300",
  "ease-[cubic-bezier(0.2,0,0,1)]",
  "motion-reduce:scale-100 motion-reduce:blur-[0px]"
);
const shown = "scale-100 opacity-100 blur-[0px]";
const hidden = "scale-[0.25] opacity-0 blur-[4px]";

function IconButton({ isActive, ActiveIcon, InactiveIcon }) {
  return (
    <button>
      <span className="grid place-items-center">
        <span className={cn(layer, isActive ? shown : hidden)}>
          <ActiveIcon />
        </span>
        <span className={cn(layer, isActive ? hidden : shown)}>
          <InactiveIcon />
        </span>
      </span>
    </button>
  );
}
```

Tailwind 4's `scale-*` utilities write the `scale` property, so `transition-[...scale]` animates them. Tailwind 3's write `transform`, so name `transform` in the transition instead.

### Which icons animate

| Animate | Don't animate |
| --- | --- |
| Infrequent state swaps such as play to pause, like to liked or copy to copied | Hover-revealed actions in list rows |
| Icons in a toolbar that appears on selection | Tab and navigation icon swaps |
| Loading and success indicators | Decorative or always-visible icons |

## Hold to confirm

For destructive actions where a plain click is too easy to fire by accident.

```css
.overlay {
  clip-path: inset(0 100% 0 0);
  transition: clip-path 200ms var(--ease-out); /* release: snappy */
}

.button:active .overlay {
  clip-path: inset(0 0 0 0);
  transition: clip-path 2s linear;             /* press: slow and deliberate */
}

.button:not(:disabled):active {
  scale: 0.96;
}
```

`linear` is correct here: the fill is a progress indicator, and progress shouldn't ease. Slow where the user is deciding, fast where the system responds.

## Tab indicator with a color transition

Timing individual color transitions across a tab list never quite lands. Clip instead.

Duplicate the tab list. Style the copy as the active state, with a different background and text color. Clip the copy so only the active tab shows, and animate the clip on change:

```css
.tabs-active-copy {
  clip-path: inset(0 60% 0 20%); /* driven by the active tab's position */
  transition: clip-path 250ms var(--ease-in-out);
}
```

The text and background change together, in perfect sync, because they're one element being revealed rather than two colors being interpolated.

Use it on tab lists switched occasionally, such as a marketing or docs page. App tabs switched tens of times a day are high-frequency: they swap instantly, or transition `opacity` or `background-color` in `150ms` or less ([frequency](index.md#1-should-this-animate-at-all)).

## Scroll reveal

Marketing surfaces only. Don't do this to functional UI a user visits daily.

```css
.reveal {
  clip-path: inset(0 0 100% 0);
  transition: clip-path 600ms var(--ease-in-out);
}

.reveal[data-visible] {
  clip-path: inset(0 0 0 0);
}
```

Trigger with `IntersectionObserver`, or Motion's `useInView` with `{ once: true, margin: "-100px" }`. Fire it once: re-animating on every scroll-by is an interface fighting its reader.

## Masking a crossfade that won't settle

When two states overlap visibly during a transition and no amount of easing or duration tuning fixes it, blur the seam. Combined with press feedback it gives a polished button state transition:

```css
.button {
  transition-property: scale;
  transition-duration: 150ms;
  transition-timing-function: ease-out;
}

.button:not(:disabled):active {
  scale: 0.96;
}

.button-content {
  transition:
    filter 200ms ease,
    opacity 200ms ease;
}

.button-content.transitioning {
  filter: blur(2px);
  opacity: 0.7;
}
```

Without blur the eye reads two distinct objects swapping. Blur blends them into one perceived transformation. Keep it under `20px`: heavy blur is expensive, especially in Safari.

## Suppress transitions on theme switch

Inject a stylesheet that turns off every transition, force a style flush so the new colors commit while it applies, then remove it after the next frame:

```tsx
"use client";

import { useEffect } from "react";

export function DisableThemeTransitions() {
  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");

    const handleChange = () => {
      const style = document.createElement("style");
      style.append(
        document.createTextNode(
          "*,*::before,*::after{transition:none !important}"
        )
      );
      document.head.append(style);

      void document.body.offsetHeight; // forces a synchronous style flush

      requestAnimationFrame(() => {
        requestAnimationFrame(() => style.remove());
      });
    };

    mql.addEventListener("change", handleChange);
    return () => mql.removeEventListener("change", handleChange);
  }, []);

  return null;
}
```

The new theme resolves while the override is still in the document, so no transition starts. The nested `requestAnimationFrame` removes the override only after that paint.

That covers the OS-level change. An in-app toggle needs the same steps around its own flip: apply the override, change the theme, flush and remove. `next-themes` ships this as `disableTransitionOnChange`.

## Reduced-motion fallback

The opacity fade runs for everyone, and movement, scale and blur join it only without the preference:

```css
.panel {
  transition: opacity 150ms ease-out;
}

@media (prefers-reduced-motion: no-preference) {
  .panel {
    transition-property: opacity, translate, scale, filter;
    transition-duration: 300ms;
  }
}
```

In Tailwind, prefix movement, scale and blur utilities with `motion-safe:`. In Motion, wrap the app in `<MotionConfig reducedMotion="user">`. It turns off transform and layout animations under the preference and keeps opacity. Blur still runs there, so branch on `useReducedMotion()` where a recipe animates `filter`.

## Programmatic, without a library

When the motion needs JS control but not a dependency, WAAPI gives you CSS-grade performance:

```js
element.animate(
  [{ clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0 0)' }],
  { duration: 1000, fill: 'forwards', easing: 'cubic-bezier(0.77, 0, 0.175, 1)' }
);
```

Can run off the main thread, interruptible, no bundle cost.
