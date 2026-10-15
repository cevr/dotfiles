# Android

How the skill's rules are built on Android. Read this after [SKILL.md](../../SKILL.md) for any Android project, then the domain references with their Android files below.

## Stack

- **Framework**: Jetpack Compose first. Follow the project where it is still on Views (XML layouts, Material Components for Android), and interoperate through `AndroidView` / `ComposeView` rather than rewriting.
- **System**: Material 3 is the platform convention ([precedence](../../SKILL.md#precedence)). Components from `androidx.compose.material3` (`Scaffold`, `TopAppBar`, `NavigationBar`, `ModalBottomSheet`, `DropdownMenu`, `Snackbar`, buttons, chips, text fields) come before custom ones. They carry touch targets, semantics, ripple, and theming for free.
- **Theme**: `MaterialTheme` with a `colorScheme` (dynamic color on Android 12+ where the brand allows it), `typography`, and `shapes`; read values through `MaterialTheme.colorScheme.*` and `MaterialTheme.typography.*`, never literals. Text sizes in `sp`, everything else in `dp`.
- **Icons**: Material Symbols, or the project's vector drawables.
- **Animation**: Compose animation APIs, with Material motion tokens where the project uses them. → [motion](../../references/motion/index.md)

## Android References

| File | Read when |
| --- | --- |
| [Theming](theming.md) | `MaterialTheme` wrapper, `CompositionLocal` tokens, `*Defaults` variants, Dialog/`ComposeView` theming, XML window and splash theme, `@Preview` design-system gallery |
| [Motion](motion.md) | Any animation: Compose APIs per motion rule, Material `MotionScheme` and easing tokens and where they win, removed animations, `draggable`/`AnchoredDraggable` velocity and snapping, performance, review rows |
| [Surfaces](surfaces.md) | M3 shape scale, tonal vs shadow elevation, `dropShadow`, clip and border |
| [Icons](icons.md) | Material Symbols axes, `Icon` tint, `autoMirrored`, `contentDescription` |
| [Color](color.md) | Material 3 `ColorScheme` roles mapped to the role inventory, dynamic color, dark theme, Android 14 contrast levels, extended status colors, wide gamut |
| [Typography](typography.md) | Material 3 type scale, `sp` and nonlinear font scaling, `TextStyle` line height, tracking and features, `LineBreak`/`Hyphens`, truncation, fonts |
| [Layout](layout.md) | Window size classes, canonical layouts, edge-to-edge and `WindowInsets`, foldables, start/end, peeking carousels |
| [Accessibility](accessibility.md) | Compose semantics for TalkBack, focus and keyboard, autofill content types and errors, live regions and pane titles, 48 dp targets, removed animations and font scale, Compose accessibility checks |
| [Writing](writing.md) | String resources, plurals, ICU formatters, Material writing conventions, undo snackbar |

## Verify

Render each state in Compose previews (`@Preview`, with `uiMode` for dark, `fontScale` for large text, a right-to-left `locale`, and phone and tablet `device` specs) and run it on an emulator or device. Check TalkBack and Switch Access on anything interactive, the system font size at its largest, gesture navigation insets, and remove animations (developer options) for the reduced-motion path. Animation feel needs a device. Capture commands and preview harnesses: [harness](../../workflows/harness.md#looking-at-it).
