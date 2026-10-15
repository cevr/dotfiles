# Motion standards

The strict craft bar motion is reviewed against: ten non-negotiable standards, the detection checklist that flags violations on sight, the order fixes are preferred in, severity, and when to block or approve. Default to flagging; approval is earned. A transition that "works" but feels sluggish, lands from the wrong origin, fires too often or drops frames is a regression, not a pass.

The exact values every finding cites (curves, durations, springs, pattern values) live in [motion](index.md). Pull them from there; never approximate. The procedures that apply this bar are [motion review](../../workflows/motion-review.md) and [motion audit](../../workflows/motion-audit.md).

Implementation: [web](../../platforms/web/motion.md#detection-rows) · [Apple](../../platforms/apple/motion.md#detection-rows) · [Android](../../platforms/android/motion.md#detection-rows)

## The ten standards

Every animation is measured against these. A violation is a finding.

1. **Justified motion.** Every animation answers "why does this animate?": feedback, spatial consistency, state indication, explanation, or preventing a jarring change ([purpose](index.md#2-what-is-the-purpose)). "It looks cool" on a frequently-seen element is a block. Motion is never the only feedback channel: an animated state change also leaves a static cue (color, icon or label).
2. **Frequency-appropriate.** Keyboard-initiated and 100+/day actions get **no** animation. Tens/day gets instant feedback or `150ms` or less on opacity or background color. Occasional gets standard motion. Rare/first-time can have delight ([frequency](index.md#1-should-this-animate-at-all)).
3. **Responsive easing.** Entering and exiting elements use ease-out or a strong custom curve. `ease-in` on UI is a block: it delays the moment the user watches most. Built-in keyword curves are too weak for component open/close and on-screen movement; expect the strong curves. The small patterns that specify a keyword curve (press, staged entrance, subtle exit, high-frequency hover, toast) are correct as written ([easing](index.md#5-easing)).
4. **UI at or under 300ms.** Anything slower on a UI element needs a stated reason. Per-element budgets are in [duration](index.md#6-duration).
5. **Origin and physical correctness.** Popovers, dropdowns and tooltips scale from their trigger (the transform origin), not center; modals are exempt and stay centered. Never animate from scale `0`: surfaces start from `0.9` or higher with opacity, and only an icon cross-fade starts at `0.25`, with blur. A press scales to exactly `0.96`, and a disabled control never scales.
6. **Interruptibility.** Rapidly-triggered or gesture-driven motion (toasts, toggles, open/close, drags) is interruptible: transitions or springs that retarget from the current state, not fixed timelines that restart from zero. Gestures start from the live on-screen value and never lock out input ([gestures](gestures.md#interruptibility-the-single-most-important-principle)).
7. **Render-only properties.** Animate transform and opacity (plus a clip, blur under `20pt`, and accordion height). Animating size, margins, padding or position in the layout flow, an animation scoped to everything that changes, an animated shadow, per-frame writes to UI state, a per-frame value every descendant re-reads, or one of the platform's own traps on motion that plays while the app is busy is a performance finding ([performance](performance.md)).
8. **Accessibility.** Movement, scale and blur run only when the user has not asked for reduced motion, with an opacity cross-fade in their place under reduced motion: gentler, not zero. Hover motion runs only for hover-capable, precise pointers ([reduced motion and pointer gating](index.md#reduced-motion-and-pointer-gating)).
9. **Asymmetric enter and exit.** Deliberate phases (a press, a hold, a destructive confirm) animate slower; system responses snap. Exits are shorter and smaller than enters; surfaces that travel exit along the path they entered. Symmetric timing on a press-and-release or hold interaction is a finding ([enter and exit](index.md#9-enter-and-exit)).
10. **Cohesion.** Motion matches the component's personality and the rest of the product: a dashboard stays crisp. Bounce is `0` everywhere except the release of a momentum gesture. The same detail animated two ways within the project, mismatched personality, or a jarring crossfade where a subtle blur would bridge two states is a finding. When unsure whether motion feels right, the strongest move is often to delete it.

## Detection checklist

Flag these on sight, hard. Each row is also the self-check before handing off any animation. Each platform file adds the rows that are spelled in its code ([web](../../platforms/web/motion.md#detection-rows), [Apple](../../platforms/apple/motion.md#detection-rows), [Android](../../platforms/android/motion.md#detection-rows)).

| Detection | Fix |
| --- | --- |
| An animation scoped to everything that changes | Name the exact changing properties |
| An entrance from scale `0` | Scale `0.95` + opacity `0` |
| Pure-fade entrance on a trigger-anchored surface (outside the reduced-motion fallback) | Add the initial scale `0.95` from the trigger |
| `ease-in` on any UI interaction | Ease-out or a strong custom curve |
| A keyword ease-out on a component open/close or on-screen movement | Strong ease-out `(0.23, 1, 0.32, 1)` (movement: strong ease-in-out `(0.77, 0, 0.175, 1)`) |
| Animation on a keyboard shortcut, command-palette toggle or 100+/day action | No animation |
| Expressive motion on a row hover, tab switch or other tens/day interaction | Instant, or `150ms` or less on opacity/background color |
| UI duration over 300ms with no stated reason | 150–250ms |
| A centered (or default) transform origin on a trigger-anchored popover, dropdown or tooltip | Anchor at the trigger; modals are exempt, keep them centered |
| A fixed-timeline (keyframe) animation on toasts, toggles, hover, open/close or another toggled state | A retargeting transition or a spring on the same properties |
| Animating size, margins, padding or position in the flow | Transform / opacity (accordion height tolerated) |
| Animated shadow | The platform's cheaper form ([performance](performance.md#what-you-animate)) |
| UI state written inside frame, pointer, scroll or drag handlers | A direct write to the rendered element, or an animated value |
| A per-frame value on a parent that every descendant re-reads | Write the transform on the animating element directly |
| Animated blur above `20pt` | Under `20pt`; `2`–`5pt` for a crossfade |
| A press scale other than `0.96` | `0.96` |
| A press scale that also fires on a disabled control | Exclude the disabled state |
| Bounce above `0` anywhere but a momentum gesture's release | Bounce `0` |
| Movement, scale or blur with no reduced-motion branch | Gate it and cross-fade opacity under reduced motion |
| Reduced-motion handling that removes all feedback | Keep the opacity cross-fade; drop only movement |
| Hover motion that also fires on touch | Gate it to hover-capable, precise pointers |
| Color transitions that all fire on a theme switch | Suppress transitions for the switch ([theme switches](index.md#theme-switches-suppress-transitions)) |
| A state swap that animates in on first appearance, or an intentional entrance suppressed on first appearance | Skip the first-appearance animation on state swaps only |
| A hidden starting state that only the animation reveals (the element stays invisible if the animation never runs) | Put the hidden state in the animation itself |
| State change carried by motion alone | Add a static cue: color, icon or label |
| Symmetric enter/exit timing on a press-and-release or hold interaction | Slow the deliberate phase, snap the response (hold: `2s` linear, release: `200ms` ease-out) |
| Exit as long or as large as the enter | Subtle exit: `150ms`, `-12pt`, `4pt` blur, ease-out |
| Everything entering at once on an occasionally-seen group | Stagger: `100ms` between semantic chunks, `30`–`80ms` between list items |
| Tooltip delay and animation on every tooltip in a toolbar | After the first, open instantly with no animation |
| Drag that dismisses on distance only, or stops hard at a boundary | Velocity dismissal (`> ~0.11` pt/ms) and rubber-banding ([gestures](gestures.md)) |

## Remedial preference hierarchy

When proposing fixes, prefer earlier moves over later ones:

1. **Delete the animation** (high-frequency, no purpose, keyboard-triggered).
2. **Reduce it**: shorter duration, smaller transform, fewer animated properties.
3. **Fix the easing**: swap `ease-in` for ease-out or a custom curve; use a strong cubic-bezier.
4. **Fix the origin and physicality**: anchor the scale at the trigger; replace scale `0` with `0.95` + opacity.
5. **Make it interruptible**: fixed timelines to retargeting transitions, or a spring for gesture-driven motion.
6. **Move it to the cheap path**: layout properties to transform/opacity; per-frame work off the main thread and out of UI state.
7. **Asymmetric timing**: slow the deliberate phase, snap the response.
8. **Polish**: blur to mask crossfades, stagger for groups, a defined entry state, a spring for "alive" elements.
9. **Accessibility and cohesion**: add reduced-motion and hover gating; tune to match the component's personality.

## Severity

One scale for review and audit findings. A polish finding never outranks a broken interaction.

- **HIGH**: feel-breaking or interaction-breaking. `ease-in` on UI, animation on a keyboard or high-frequency action, scale `0`, dropped frames or a layout-property animation with an easy fix, a fixed-timeline toggle or open/close that cannot reverse, a hover state stuck on touch, motion that ignores the reduced-motion setting, and a state change carried by motion alone.
- **MEDIUM**: noticeably off or visibly inconsistent. Wrong origin, a rapidly-triggered element that restarts instead of retargeting, a duration over budget, bounce outside a momentum release, a press scale other than `0.96`, the same detail animated two ways.
- **LOW**: polish. Stagger, blur-masked crossfades, token consolidation.

## Verdict

- **Block** when any HIGH remains: a feel-breaking regression, animation on a keyboard or high-frequency action, scale `0` or `ease-in` on UI, a non-reversible interactive animation, motion that ignores reduced motion, or a layout-property animation with an easy render-only fix.
- **Approve** when there are no feel-breaking regressions, no obvious motion that should be deleted, durations and easing within bounds, interruptibility handled where needed, and reduced motion respected. MEDIUM and LOW findings stay in the table as work to do.

Never approve coverage you did not inspect.

## When feel is uncertain

Feel can't always be judged from code (a crossfade, a spring's bounce, the opacity/height balance of an entering list). Don't guess at a value: recommend reviewing it in slow motion, frame by frame, on a real device for gestures, and with fresh eyes the next day ([debugging](index.md#debugging)).
