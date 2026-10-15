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

## Verify

Render each state in Compose previews (`@Preview`, with `uiMode` for dark, `fontScale` for large text, a right-to-left `locale`, and phone and tablet `device` specs) and run it on an emulator or device. Check TalkBack and Switch Access on anything interactive, the system font size at its largest, gesture navigation insets, and remove animations (developer options) for the reduced-motion path. Animation feel needs a device.
