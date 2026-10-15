# Motion and zoom

Reduced motion, timed UI, text scaling and reflow.

Implementation: [web](../../platforms/web/accessibility.md#motion-and-zoom) · [Apple](../../platforms/apple/accessibility.md#motion-and-zoom) · [Android](../../platforms/android/accessibility.md#motion-and-zoom)

## Reduced motion

Motion is opt-in behind the system's reduced-motion setting: users who asked for reduced motion get the static version without an override per animation. This file owns the requirement; how each animation implements its fallback is in [motion](../motion/index.md#reduced-motion-and-pointer-gating).

**Web:** wrap animations in `@media (prefers-reduced-motion: no-preference)`, or Tailwind `motion-safe:`; examples in the [web file](../../platforms/web/accessibility.md#prefers-reduced-motion).

### What to disable vs reduce

Reduced motion targets vestibular triggers, not feedback.

| Disable entirely | Replace | Keep |
| --- | --- | --- |
| Parallax scrolling | Slide/scale/zoom transitions → opacity crossfade | Loading spinners and progress |
| Autoplaying video, GIFs, looping decoration | Smooth scrolling → instant jump | Instant state changes (hover color, focus ring) |
| Spinning, large-scale movement across the screen | Auto-rotating carousels → start paused | Brief functional feedback (button press) |

## Autoplay and timed UI

- **Visible controls on anything that moves on its own** (2.2.2). Anything moving, blinking or updating on its own for more than 5 seconds needs a visible pause or stop control, muted looping hero videos included.
- **Explicit dismissal over timers.** Auto-dismissal suits low-stakes confirmations and nothing else. A toast carrying an action, an error or information the user may need stays until dismissed.
- **Pause on attention.** Where a toast must time out, give it at least 5 seconds, and pause the timer while it is hovered or focused. Where the platform has a user setting for how long timed messages stay, honor it.
- **Never put critical information only in a timed element.** A vanished toast with the only link to an undo action is data loss on a schedule.

## Zoom and reflow

- **200% text resize** (1.4.4). All content and functionality survives text scaled to 200% through the platform's text-size setting: browser zoom and font size, Dynamic Type, Android font scale.
- **Reflow at 320 pt** (1.4.10). At a 320 pt-wide viewport the screen works with scrolling in one direction alone. Genuinely 2D content is the exception: tables, maps and code blocks scroll inside their own container.
- **Containers grow with their text.** A text container takes a minimum height, never a fixed one; the rest of that fix belongs to [layout](../layout/spacing-and-adaptivity.md).
- **Breakpoints follow text size.** Where the platform allows, switch to the narrow layout when the text needs it, not only when the window narrows. Breakpoint placement belongs to [layout](../layout/spacing-and-adaptivity.md).

**Web:** the 400%-zoom equivalence, `rem` media queries and the viewport meta rule are in the [web file](../../platforms/web/accessibility.md#zoom-and-reflow).
