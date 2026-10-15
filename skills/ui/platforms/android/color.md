# Color on Android

How the [color](../../references/color/index.md) rules are built in Jetpack Compose with Material 3. The rules, thresholds and ramp properties live there; this file maps them to `MaterialTheme.colorScheme` and states where Material's conventions win.

## The Material scheme wins

`ColorScheme` is the semantic tier: components read its roles, never literals. Material generates every role from a seed color through tonal palettes (HCT tones `0`–`100`), each role a fixed tone. That replaces the neutral [ramp building](../../references/color/palette-generation.md) and the Tailwind or Radix step conventions: generate the scheme with the [Material Theme Builder](https://material-foundation.github.io/material-theme-builder/), which exports `Color.kt` and `Theme.kt`, and pin a contractual brand color there. Material's own names also win: `primary` is the brand accent, so the neutral [reserve `primary`](../../references/color/token-naming.md#naming-grammar) rule yields.

The neutral [role inventory](../../references/color/token-naming.md#the-role-inventory) in Material roles:

| Neutral role | `MaterialTheme.colorScheme` |
| --- | --- |
| Page background | `surface` (`background` survives for legacy and matches it) |
| Surfaces by elevation | `surfaceContainerLowest`, `surfaceContainerLow`, `surfaceContainer`, `surfaceContainerHigh`, `surfaceContainerHighest`; `surfaceDim`, `surfaceBright` for the extremes. Material components choose their own tone; leave it |
| Overlay scrim | `scrim` |
| Text primary, secondary | `onSurface`, `onSurfaceVariant` |
| Text disabled | `onSurface.copy(alpha = 0.38f)`, Material's disabled alpha |
| Inverse | `inverseSurface`, `inverseOnSurface`, `inversePrimary` (snackbars) |
| Border, focus-adjacent edges | `outline` |
| Subtle border, separator | `outlineVariant` |
| Accent solid, text on it | `primary`, `onPrimary` |
| Accent subtle background, text on it | `primaryContainer`, `onPrimaryContainer` |
| Lower-emphasis and contrasting accents | `secondary*`, `tertiary*` roles; use them as Material components do, not as new hues |
| Danger | `error`, `onError`, `errorContainer`, `onErrorContainer` |
| Accent that stays put across appearances | `primaryFixed`, `primaryFixedDim`, `onPrimaryFixed`, `onPrimaryFixedVariant` |
| Warning, success, info | No Material role. Add an extended scheme (below) |

Every container role pairs with its `on*` role; draw content on a container in its pair, or ask `contentColorFor(container)`.

Status colors Material lacks go in an extended scheme with the same container and on-container shape, provided once in the theme:

```kotlin
@Immutable data class StatusColors(val success: Color, val onSuccess: Color,
    val successContainer: Color, val onSuccessContainer: Color)
val LocalStatusColors = staticCompositionLocalOf { lightStatusColors }
// In AppTheme: CompositionLocalProvider(LocalStatusColors provides if (darkTheme) darkStatusColors else lightStatusColors) { … }
```

## Dynamic color

On Android 12+ (API 31) the scheme can derive from the wallpaper. Whether the brand allows that is a brand decision: with dynamic color on, the brand hue appears only where you pin it. Keep a static scheme for older devices.

```kotlin
@Composable
fun AppTheme(darkTheme: Boolean = isSystemInDarkTheme(), dynamicColor: Boolean = true,
             content: @Composable () -> Unit) {
    val context = LocalContext.current
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ->
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        darkTheme -> DarkColors
        else -> LightColors
    }
    MaterialTheme(colorScheme = colorScheme, typography = AppTypography, content = content)
}
```

## Appearances

- **Light and dark.** `isSystemInDarkTheme()` picks the scheme once, in the theme; that is the one [switching mechanism](../../references/color/palette-generation.md#one-switching-mechanism). A user override passes a stored preference as `darkTheme`. Components read `colorScheme` and never branch on the system setting themselves.
- **Contrast.** Android 14 (API 34) adds a user contrast setting. `UiModeManager.getContrast()` returns `-1` to `1`, `0` being the default; `addContrastChangeListener` reports changes. Its docs say an app needs it only for rendering outside the Material pipeline. On API 34+, `dynamicLightColorScheme` reads the system's `system_*_light` colors, which follow the setting. A static brand scheme does not: the Theme Builder exports medium- and high-contrast light and dark schemes, and the theme picks one by level:

```kotlin
val contrast = if (Build.VERSION.SDK_INT >= 34)
    context.getSystemService(UiModeManager::class.java).contrast else 0f
val scheme = when {  // contrast scheme names as exported by the Theme Builder
    contrast >= 1f -> if (darkTheme) highContrastDarkColorScheme else highContrastLightColorScheme
    contrast >= 0.5f -> if (darkTheme) mediumContrastDarkColorScheme else mediumContrastLightColorScheme
    else -> if (darkTheme) DarkColors else LightColors
}
```

The `0.5` and `1` thresholds are material-color-utilities' medium and high contrast levels. Each appearance gets its own contrast variant, as the neutral [increased contrast](../../references/color/color-usage.md#light-dark-and-increased-contrast) rule requires.

## Formats and gamut

Android stores ARGB or float components in a named color space, not OKLCH. Build in OKLCH with a [color library](../../references/color/palette-generation.md#use-a-color-library) and paste the result.

| Need | API |
| --- | --- |
| sRGB value | `Color(0xFF11AD32)` |
| P3 value | `Color(0.25f, 0.70f, 0.20f, colorSpace = ColorSpaces.DisplayP3)` |
| P3 that actually renders | `android:colorMode="wideColorGamut"` on the activity (API 26+); without it the window is sRGB and the P3 value clips |
| Derived color | `lerp(start, stop, fraction)`, which interpolates in Oklab |
| Alpha over a background | `fg.compositeOver(bg)` resolves it to the rendered color |
| Gradient interpolation | `Brush.linearGradient(colors)` takes no interpolation space; add intermediate stops from `lerp` for the Oklab look |

## Measuring contrast

Measure the resolved scheme color in each appearance and contrast level. `ColorUtils.calculateContrast(fg.toArgb(), bg.toArgb())` (androidx.core) returns the WCAG ratio for an opaque background; composite a translucent foreground with `compositeOver` first. Preview each scheme with `@Preview(uiMode = Configuration.UI_MODE_NIGHT_YES)`, and run Accessibility Scanner on a device for rendered pairs.

## Auditing

To [inventory a palette](../../references/color/palette-structure.md#auditing-an-existing-palette), grep for `Color(0x`, `Color(red`, `Color.Black`, `Color.White`, `Color.Gray`, `<color` in `res/values*/colors.xml`, `@color/`, and `android:fillColor="#` or `android:textColor="#` in XML and vector drawables.

## Before you finish

| Pattern | Fix |
| --- | --- |
| `Color(0xFF…)` or `Color.Black` inside a composable | A `colorScheme` role, or an extended-scheme role |
| Content on a container in a color other than its `on*` pair | The `on*` pair, or `contentColorFor` |
| `isSystemInDarkTheme()` read inside a component | Read `MaterialTheme.colorScheme` |
| A dark scheme written by inverting the light one | Generate it with the Theme Builder |
| A static brand scheme with no medium- or high-contrast variants | Export and wire them |
| Dynamic color with no static fallback below API 31 | A static scheme for older devices |
| Warning or success hues as top-level `val`s used directly | An extended scheme with light, dark and contrast values |
| A `DisplayP3` color with no wide color mode on the activity | Add `wideColorGamut`, or keep the sRGB value |
