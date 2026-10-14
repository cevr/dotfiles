# Motion standards

The strict craft bar motion is reviewed against: ten non-negotiable standards, the detection checklist that flags violations on sight, the order fixes are preferred in, severity, and when to block or approve. Default to flagging; approval is earned. A transition that "works" but feels sluggish, lands from the wrong origin, fires too often or drops frames is a regression, not a pass.

The exact values every finding cites (curves, durations, springs) live in [motion](index.md) and [recipes.md](recipes.md). Pull them from there; never approximate. The procedures that apply this bar are [motion review](../../workflows/motion-review.md) and [motion audit](../../workflows/motion-audit.md).

## The ten standards

Every animation is measured against these. A violation is a finding.

1. **Justified motion.** Every animation answers "why does this animate?": feedback, spatial consistency, state indication, explanation, or preventing a jarring change ([purpose](index.md#2-what-is-the-purpose)). "It looks cool" on a frequently-seen element is a block. Motion is never the only feedback channel: an animated state change also leaves a static cue (color, icon or label).
2. **Frequency-appropriate.** Keyboard-initiated and 100+/day actions get **no** animation. Tens/day gets instant feedback or `150ms` or less on `opacity` or `background-color`. Occasional gets standard motion. Rare/first-time can have delight ([frequency](index.md#1-should-this-animate-at-all)).
3. **Responsive easing.** Entering and exiting elements use `ease-out` or a strong custom curve. `ease-in` on UI is a block: it delays the moment the user watches most. Built-in keywords are too weak for component open/close and on-screen movement; expect the custom cubic-beziers. The small recipes that specify a keyword (press, staged entrance, subtle exit, high-frequency hover, toast) are correct as written ([easing](index.md#5-easing)).
4. **UI at or under 300ms.** Anything slower on a UI element needs a stated reason. Per-element budgets are in [duration](index.md#6-duration).
5. **Origin and physical correctness.** Popovers, dropdowns and tooltips scale from their trigger (`transform-origin`), not center; modals are exempt and stay centered. Never animate from `scale(0)`: surfaces start from `scale(0.9)` or higher with opacity, and only an icon cross-fade starts at `0.25`, with blur. A press scales to exactly `0.96`, and a disabled control never scales.
6. **Interruptibility.** Rapidly-triggered or gesture-driven motion (toasts, toggles, open/close, drags) is interruptible: CSS transitions or springs that retarget from the current state, not keyframes that restart from zero. Gestures start from the live on-screen value and never lock out input ([gestures](gestures.md#interruptibility-the-single-most-important-principle)).
7. **Composite-only properties.** Animate `transform` and `opacity` (plus `clip-path`, blur under `20px`, and accordion `height`). Animating `width`, `height`, `margin`, `padding`, `top` or `left`, `transition: all`, animated `box-shadow`, per-frame React state, a parent CSS variable driving child transforms, or Motion `x`/`y`/`scale` shorthands on motion that plays while the page is busy is a performance finding ([performance](performance.md)).
8. **Accessibility.** Movement, scale and blur run only under `prefers-reduced-motion: no-preference`, with an opacity cross-fade in their place under reduced motion: gentler, not zero. Hover motion is gated behind `@media (hover: hover) and (pointer: fine)` ([reduced motion and pointer gating](index.md#reduced-motion-and-pointer-gating)).
9. **Asymmetric enter and exit.** Deliberate phases (a press, a hold, a destructive confirm) animate slower; system responses snap. Exits are shorter and smaller than enters; surfaces that travel exit along the path they entered. Symmetric timing on a press-and-release or hold interaction is a finding ([enter and exit](index.md#9-enter-and-exit)).
10. **Cohesion.** Motion matches the component's personality and the rest of the product: a dashboard stays crisp. Bounce is `0` everywhere except the release of a momentum gesture. The same detail animated two ways within the project, mismatched personality, or a jarring crossfade where a subtle blur would bridge two states is a finding. When unsure whether motion feels right, the strongest move is often to delete it.

## Detection checklist

Flag these on sight, hard. Each row is also the self-check before handing off any animation.

| Detection | Fix |
| --- | --- |
| `transition: all` or `transition-all` | Name the exact changing properties: `transition: transform 200ms ease-out` |
| `transform: scale(0)` entrance | `scale(0.95)` + `opacity: 0` |
| Pure-fade entrance on a trigger-anchored surface (outside the reduced-motion fallback) | Add the initial `scale(0.95)` from `var(--transform-origin)` |
| `ease-in` on any UI interaction | `ease-out` or a strong custom curve |
| Built-in `ease-out` on a component open/close or on-screen movement | `cubic-bezier(0.23, 1, 0.32, 1)` (movement: `cubic-bezier(0.77, 0, 0.175, 1)`) |
| Animation on a keyboard shortcut, command-palette toggle or 100+/day action | No animation |
| Expressive motion on a row hover, tab switch or other tens/day interaction | Instant, or `150ms` or less on `opacity`/`background-color` |
| UI duration over 300ms with no stated reason | 150–250ms |
| `transform-origin: center` (or none) on a trigger-anchored popover, dropdown or tooltip | `var(--transform-origin)`; modals are exempt, keep them centered |
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
| Reduced-motion handling that removes all feedback | Keep the opacity cross-fade; drop only movement |
| Ungated `:hover` motion (plain CSS, or Tailwind 3 `hover:`) | `@media (hover: hover) and (pointer: fine)` |
| Color transitions plus a theme toggle with no `disableTransitionOnChange` or override | The [theme-switch suppression recipe](recipes.md#suppress-transitions-on-theme-switch) |
| `will-change: all`, or `will-change` on an element that never animates | Name the animated property or delete it |
| React: `AnimatePresence` around a state swap with no `initial={false}`, or `initial={false}` around an intentional entrance | `initial={false}` on state swaps only |
| State change carried by motion alone | Add a static cue: color, icon or label |
| Symmetric enter/exit timing on a press-and-release or hold interaction | Slow the deliberate phase, snap the response (hold: `2s linear`, release: `200ms ease-out`) |
| Exit as long or as large as the enter | Subtle exit: `150ms`, `-12px`, `4px` blur, `ease-out` |
| Everything entering at once on an occasionally-seen group | Stagger: `100ms` between semantic chunks, `30`–`80ms` between list items |
| Tooltip delay and animation on every tooltip in a toolbar | After the first, open instantly with no animation |
| Drag that dismisses on distance only, or stops hard at a boundary | Velocity dismissal (`> ~0.11` px/ms) and rubber-banding ([gestures](gestures.md)) |

## Remedial preference hierarchy

When proposing fixes, prefer earlier moves over later ones:

1. **Delete the animation** (high-frequency, no purpose, keyboard-triggered).
2. **Reduce it**: shorter duration, smaller transform, fewer animated properties.
3. **Fix the easing**: swap `ease-in` for `ease-out` or a custom curve; use a strong cubic-bezier.
4. **Fix the origin and physicality**: correct `transform-origin`; replace `scale(0)` with `scale(0.95)` + opacity.
5. **Make it interruptible**: keyframes to transitions, or a spring for gesture-driven motion.
6. **Move it to the compositor**: layout properties to `transform`/`opacity`; a shorthand to the full `transform` string; WAAPI for programmatic CSS.
7. **Asymmetric timing**: slow the deliberate phase, snap the response.
8. **Polish**: blur to mask crossfades, stagger for groups, `@starting-style` for entry, a spring for "alive" elements.
9. **Accessibility and cohesion**: add reduced-motion and hover gating; tune to match the component's personality.

## Severity

One scale for review and audit findings. A polish finding never outranks a broken interaction.

- **HIGH**: feel-breaking or interaction-breaking. `ease-in` on UI, animation on a keyboard or high-frequency action, `scale(0)`, dropped frames or a layout-property animation with an easy compositor fix, a keyframe toggle or open/close that cannot reverse, a hover state stuck on touch, motion that ignores `prefers-reduced-motion`, and a state change carried by motion alone.
- **MEDIUM**: noticeably off or visibly inconsistent. Wrong origin, a rapidly-triggered element that restarts instead of retargeting, a duration over budget, bounce outside a momentum release, a press scale other than `0.96`, the same detail animated two ways.
- **LOW**: polish. Stagger, blur-masked crossfades, token consolidation.

## Verdict

- **Block** when any HIGH remains: a feel-breaking regression, animation on a keyboard or high-frequency action, `scale(0)` or `ease-in` on UI, a non-reversible interactive animation, motion that ignores reduced motion, or a non-compositor animation with an easy compositor fix.
- **Approve** when there are no feel-breaking regressions, no obvious motion that should be deleted, durations and easing within bounds, interruptibility handled where needed, and reduced motion respected. MEDIUM and LOW findings stay in the table as work to do.

Never approve coverage you did not inspect.

## When feel is uncertain

Feel can't always be judged from code (a crossfade, a spring's bounce, the opacity/height balance of an entering list). Don't guess at a value: recommend reviewing it in slow motion, frame by frame, on a real device for gestures, and with fresh eyes the next day ([debugging](index.md#debugging)).
