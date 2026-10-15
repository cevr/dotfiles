# Icons on Android

Material Symbols and Jetpack Compose implementation of [icons](../../references/icons.md). The rules, values and reasons live there; this file maps each one to the API and names where Material 3 replaces a value.

## Platform conventions that win

| Neutral rule | Material convention |
| --- | --- |
| Library | Material Symbols, downloaded as vector drawables (Google Fonts icons, Android tab). The `Icons.*` library (`material-icons-core`/`-extended`) is no longer maintained or recommended, and the extended set slows builds significantly; keep it only where a project already depends on it. |
| [Stroke matched to text weight](../../references/icons.md#match-icon-stroke-to-text-weight) | The `wght` axis replaces the stroke table: pick the weight of the adjacent text (`400` with regular body text, `500`–`600` with medium or semibold labels, `700` with bold). |
| Per-size grids | The `opsz` axis (`20`–`48`): download at the size the icon renders, `20` for dense UI, `24` standard, `40`/`48` for large. |
| Disabled at `0.4` opacity | M3 disables icons at `0.38` opacity of `onSurface`; components apply it themselves. |
| Default size | `Icon` draws at `24dp`; icons inside buttons at `ButtonDefaults.IconSize` (`18dp`). |

### Material Symbols axes

| Axis | Range | Default | Use |
| --- | --- | --- | --- |
| `FILL` | `0`–`1` | `0` | `0` outline at rest, `1` filled when active |
| `wght` | `100`–`700` | `400` | Match the adjacent text weight |
| `GRAD` | `-50`–`200` (`-25`, `0`, `200` in the picker) | `0` | `-25` to cut glare for light icons on dark backgrounds; positive for emphasis without changing size |
| `opsz` | `20`–`48` | `24` (Google's docs list both `24` and `48`) | Match the rendered size in `dp` |

A downloaded vector bakes its axis values in, so each state is its own drawable: download the outline (`FILL 0`) and filled (`FILL 1`) pair at the same `wght`, `GRAD` and `opsz`. The Material Symbols variable font can set axes at runtime through `FontVariation.Settings` on a `Text` glyph (unverified for icon ligatures in Compose); drawables are the default.

## Color and state

[Rule](../../references/icons.md#one-glyph-recolored-per-state). `Icon` tints with `LocalContentColor.current` by default, and `Surface`, `Button`, `IconButton`, `NavigationBarItem` and `ListItem` provide that color, including the disabled and selected colors. Leave `tint` unset inside components; set it only to a theme role.

```kotlin
IconToggleButton(checked = saved, onCheckedChange = { saved = it }) {
    Icon(
        painter = painterResource(if (saved) R.drawable.bookmark_fill else R.drawable.bookmark),
        contentDescription = stringResource(R.string.save),
    ) // tint comes from IconButtonDefaults.iconToggleButtonColors via LocalContentColor
}
```

`tint = Color.Unspecified` draws a multicolor drawable untinted; strip hardcoded `android:fillColor` values in single-color icons to a solid color (Compose replaces it with the tint).

## Outline and fill

[Rule](../../references/icons.md#outline-default-fill-active). Pass the filled drawable when selected, as above. In a `NavigationBar`, the selected `NavigationBarItem` shows the filled icon and the rest the outline, per Material's navigation guidance:

```kotlin
NavigationBarItem(
    selected = selected,
    onClick = onClick,
    icon = { Icon(painterResource(if (selected) R.drawable.home_fill else R.drawable.home), null) },
    label = { Text(stringResource(R.string.home)) },
)
```

The label names the destination, so the icon's `contentDescription` is `null`. Animate infrequent swaps with `Crossfade(targetState = saved)` or an `AnimatedVectorDrawable` (`rememberAnimatedVectorPainter`), following the [motion rules](../../references/motion/index.md#icons-cross-fade-on-infrequent-swaps); a selected tab swaps instantly.

## RTL

[Rule](../../references/icons.md#icons-in-rtl).

- Vector drawables: set `android:autoMirrored="true"` on directional icons. Compose's `painterResource` honors it and flips the icon in `LayoutDirection.Rtl`.
- `ImageVector.Builder(autoMirror = true)` does the same for a code-built vector.
- On the legacy `Icons` library, use `Icons.AutoMirrored.Filled.ArrowBack` and the other `AutoMirrored` icons in place of the non-mirrored directional ones (deprecation of the non-mirrored set unverified).
- One mechanism per icon: no `Modifier.scale(scaleX = -1f, …)` on an auto-mirrored icon.
- Playback drawables stay without `autoMirrored`.

## Accessibility

- `contentDescription = null` for decorative icons and for icons whose parent already carries the text (a labelled button, a `NavigationBarItem` with a label, a `ListItem` headline).
- An `IconButton` with no text gets its name from the `Icon`'s `contentDescription`, naming the action ("Save"), not the glyph ("Bookmark").

## Before you finish

| Detection | Fix |
| --- | --- |
| `Icons.Filled.*` / `Icons.Outlined.*` from `material-icons-extended` in a new screen | Material Symbols drawables |
| `Icons.Filled.ArrowBack` (or another non-mirrored directional icon) | `Icons.AutoMirrored.Filled.ArrowBack` |
| A directional vector drawable without `android:autoMirrored="true"` | Add it |
| `tint = Color(0xFF…)` or `Color.Gray` on an `Icon` | Leave the default, or a `colorScheme` role |
| Icon weight (`wght`) heavier or lighter than its label | Re-download at the label's weight |
| `contentDescription` on an icon whose label sits beside it | `null` |
| PNG icons in `drawable-*dpi` | Vector drawables |
