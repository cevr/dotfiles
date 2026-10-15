# Theming on Android

Jetpack Compose with Material 3 (and the Views theme where it still matters) for the rules in [theming](../../references/theming.md), plus the Android side of [design systems](../../references/design-system.md) and [interface judgment](../../references/interface-judgment.md).

## Where the System Lives

| Neutral | Android |
| --- | --- |
| [Token definitions](../../references/theming.md#find-the-system-first) | The app's theme wrapper (`ui/theme/Theme.kt`, with `Color.kt`, `Type.kt`, `Shape.kt` in the Android Studio template): `lightColorScheme` / `darkColorScheme`, `Typography`, `Shapes`, plus any `CompositionLocal` for extra tokens |
| Mode mechanism | `isSystemInDarkTheme()` as the wrapper's default; dynamic color through `dynamicLightColorScheme(context)` / `dynamicDarkColorScheme(context)` on Android 12+ where the brand allows it |
| Shared components | The project's wrappers around Material components and their `*Defaults` overrides |
| Views theme | `res/values/themes.xml` and `res/values-night/themes.xml`: still drives the window, splash, and any View-based screens ([mode edges](#mode-edges)) |

## Colors as Roles

Read roles through `MaterialTheme.colorScheme`, paired with their `on*` foreground: `primary` / `onPrimary`, `surface` / `onSurface`, `surfaceVariant` / `onSurfaceVariant`, `error` / `onError`. `contentColorFor(background)` returns the matching foreground. A `Color(0xFF…)` or `Color.Blue` at a use site is the [palette bypass](../../references/theming.md#color-by-role-not-palette). Text sizes are `sp`, everything else `dp`.

## Extra Tokens Through CompositionLocal

Roles Material doesn't have (a `caution` color, spacing, brand radii) go in a theme wrapper that provides them next to `MaterialTheme`:

```kotlin
@Immutable data class ExtendedColors(val caution: Color, val onCaution: Color)
val LocalExtendedColors = staticCompositionLocalOf {
    ExtendedColors(caution = Color.Unspecified, onCaution = Color.Unspecified)
}

@Composable
fun AppTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val extended = if (darkTheme) DarkExtendedColors else LightExtendedColors
    CompositionLocalProvider(LocalExtendedColors provides extended) {
        MaterialTheme(colorScheme = if (darkTheme) DarkColors else LightColors,
                      typography = AppTypography, content = content)
    }
}

object AppTheme {
    val extendedColors: ExtendedColors
        @Composable get() = LocalExtendedColors.current
}
```

`staticCompositionLocalOf` suits values that rarely change, such as a whole theme: a change recomposes the entire provided subtree, but reads aren't tracked. Use `compositionLocalOf` for a value that changes often, so only its readers recompose. An extension property (`val ColorScheme.caution`) is enough for a single value that's the same in every theme.

## Variants at the Source

The [customization ladder](../../references/theming.md#customizing-a-component-library) on Android:

| Step | Android |
| --- | --- |
| Theme values | `colorScheme`, `typography`, `shapes` in the wrapper |
| Built-in variants and sizes | `Button`, `FilledTonalButton`, `OutlinedButton`, `TextButton`, `ElevatedButton`; the component's own size parameters |
| A new variant | A wrapper that passes the component's `*Defaults` overrides once: `ButtonDefaults.buttonColors(containerColor = …, contentColor = …, disabledContainerColor = …)`, `CardDefaults.cardColors`, `TextFieldDefaults.colors` |
| A wrapper | A composable composing the styled components |

```kotlin
@Composable
fun CautionButton(onClick: () -> Unit, modifier: Modifier = Modifier, content: @Composable RowScope.() -> Unit) {
    Button(
        onClick = onClick,
        modifier = modifier,
        colors = ButtonDefaults.buttonColors(
            containerColor = AppTheme.extendedColors.caution,
            contentColor = AppTheme.extendedColors.onCaution,
        ),
        content = content,
    )
}
```

Unset `*Defaults` parameters keep reading `MaterialTheme`. Call-site `Modifier`s handle layout (size, padding, weight); a `colors =` override at one call site is a one-off restyle.

## States

| State | Android |
| --- | --- |
| Pressed, focused, hovered | An `interactionSource` with `collectIsPressedAsState()` / `collectIsFocusedAsState()` / `collectIsHoveredAsState()`; Material components draw these as state layers |
| Disabled | `enabled = false`; the `disabled*` colors in `*Defaults` |
| Selected / checked | `selected` on chips and navigation items, `checked` on `Switch` and `Checkbox` |
| Invalid | `isError = true` on `TextField` / `OutlinedTextField`, with `supportingText` for the message |
| Press feedback | The ripple from `LocalIndication` (`ripple()`); keep it on custom clickables |

## Motion Tokens

Keep durations and easings in the theme (a `CompositionLocal` or object). Projects on Material 3 Expressive read `MaterialTheme.motionScheme` (`defaultSpatialSpec()`, `fastSpatialSpec()`, `defaultEffectsSpec()`). The motion domain owns reduced motion.

## Overlays and New Roots

Applies [overlays carry the theme](../../references/theming.md#overlays-carry-the-theme):

| Surface | Theme |
| --- | --- |
| `Dialog`, `Popup`, `AlertDialog`, `ModalBottomSheet`, `DropdownMenu` | Open a new window but join the caller's composition, so `MaterialTheme` and custom `CompositionLocal`s carry over. The window itself (dim, decor) wraps the Activity's context theme with Compose's dialog window style, configured through `DialogProperties` |
| A `ComposeView` added from Views (a Fragment, a View-based dialog, a `RecyclerView` item) | A new composition: wrap its content in `AppTheme { … }` again |
| A new `Activity` | Its own `setContent { AppTheme { … } }` and its manifest theme |
| `MaterialAlertDialogBuilder`, `Toast`, and other View-based UI | Read the XML theme, not the Compose theme |

## Mode Edges

The Android [mode edges](../../references/theming.md#mode-edges-the-theme-doesnt-reach):

- **Window background**: the Activity's XML theme (a `Theme.Material3.DayNight.NoActionBar` descendant) sets `android:windowBackground` before Compose draws. Match it to the Compose `background` in both `values/` and `values-night/`, or launch flashes the wrong color.
- **Splash screen**: a `Theme.SplashScreen` child sets `windowSplashScreenBackground` and `windowSplashScreenAnimatedIcon` (with `values-night/` copies) and `postSplashScreenTheme`; call `installSplashScreen()` before `super.onCreate()`.
- **In-app dark mode**: passing the preference to `AppTheme(darkTheme = …)` covers Compose only. The XML theme (window, splash, View UI) follows it through `AppCompatDelegate.setDefaultNightMode` (AppCompat) or `UiModeManager.setApplicationNightMode` (API 31+).
- **App icon**: an adaptive icon's `monochrome` layer feeds themed icons on Android 13+.

## Design System

Android specifics for [design systems from a spec](../../references/design-system.md):

| Step | Android |
| --- | --- |
| [Map tokens](../../references/design-system.md#2-map-tokens-to-theme-roles) | Spec roles fill `lightColorScheme(...)` / `darkColorScheme(...)` slots; a role with no slot goes in the extended `CompositionLocal` |
| Text styles | One `TextStyle` per type token in `Typography` (`fontFamily`, `fontWeight`, `fontSize` in `sp`, `lineHeight`, `letterSpacing`). Tracking takes `em` directly: `letterSpacing = (-0.02).em` |
| Fonts | Files in `res/font/` loaded as `FontFamily(Font(R.font.brand_regular, FontWeight.Normal), …)`, or downloadable Google Fonts through `GoogleFont.Provider` |
| Variants | Each spec recipe is a wrapper with its `*Defaults` overrides |
| Shapes | Spec radii fill `Shapes(extraSmall, small, medium, large, extraLarge)` |

The design system page is a **preview gallery**: `@Preview` functions, one per foundation (color pairs, type specimen, shapes and elevation) and per component, each a grid of variants × states. `@PreviewLightDark`, `@PreviewFontScale`, `@PreviewDynamicColors`, and `@PreviewScreenSizes` cover every mode, the largest font scale, wallpaper colors, and widths with one annotation each.

Pin states through parameters the component already has: `enabled = false`, `isError = true`, `selected = true`, a loading flag. Pressed, focused, and hovered come from an `InteractionSource` and need the preview's interactive mode or a device (unverified whether a pre-seeded `InteractionSource` renders in a static preview).

## Interface Judgment

- **The top app bar already holds the title.** A `TopAppBar` names the screen; a second heading at the top of the content repeats it ([start with what the app provides](../../references/interface-judgment.md#start-with-what-the-app-already-provides)).
- **Read-only values render as metadata.** A fixed value is a `ListItem` with `headlineContent` and `supportingContent`, not a disabled `TextField` ([visual cues match behavior](../../references/interface-judgment.md#keep-visual-cues-consistent-with-behavior)).
