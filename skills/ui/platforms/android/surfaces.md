# Surfaces on Android

Jetpack Compose implementation of [surfaces](../../references/surfaces.md). The rules, values and reasons live there; this file maps each one to the API and names where Material 3 replaces a value.

## Platform conventions that win

| Neutral rule | Material 3 convention |
| --- | --- |
| Radius tokens | The M3 shape scale through `MaterialTheme.shapes` (below); components already take their slot |
| [Shadows for elevation](../../references/surfaces.md#shadows-for-elevation-borders-for-structure) | Elevation is mostly tonal: a container separates by its surface color role, with a shadow only where it must separate from a busy or patterned background |
| [Shadow recipes](../../references/surfaces.md#shadow-recipes) | M3 components use elevation levels, not the three-layer ring. Use the ring only on custom surfaces in a project whose system asks for it. |
| Image outline color | `MaterialTheme.colorScheme.outlineVariant` where the project wants a themed edge; the neutral black or white at `0.1` otherwise |

## Shape scale

| Token | `MaterialTheme.shapes` | Corner |
| --- | --- | --- |
| None | `RectangleShape` | `0dp` |
| Extra small | `extraSmall` | `4dp` |
| Small | `small` | `8dp` |
| Medium | `medium` | `12dp` |
| Large | `large` | `16dp` |
| Large increased | `largeIncreased` | `20dp` |
| Extra large | `extraLarge` | `28dp` |
| Extra large increased | `extraLargeIncreased` | `32dp` |
| Extra extra large | `extraExtraLarge` | `48dp` |
| Full | `CircleShape` | `50%` |

The three "increased" and "extra extra large" steps are the M3 Expressive additions. Override the scale once in `MaterialTheme(shapes = Shapes(…))`, and read it as `MaterialTheme.shapes.medium` at the call site, never a literal `RoundedCornerShape(12.dp)`.

**Concentric radius.** Nesting one token inside another rarely satisfies the [formula](../../references/surfaces.md#concentric-border-radius): a `medium` (`12dp`) image inside a `large` (`16dp`) card with `8dp` padding needs a `20dp` card, which is `largeIncreased`. Pick the outer token from the formula, or compute `RoundedCornerShape(inner + padding)` where no token matches. `RoundedCornerShape(topStart =, topEnd =, …)` mirrors in RTL; `AbsoluteRoundedCornerShape` does not.

## Elevation: tonal versus shadow

```kotlin
Surface(
    shape = MaterialTheme.shapes.large,
    color = MaterialTheme.colorScheme.surfaceContainerLow, // separation by color role
    tonalElevation = 0.dp,
    shadowElevation = 1.dp, // only when it sits on a busy or patterned background
) { content() }
```

- `tonalElevation` tints the surface toward the primary color as it rises, but only when `color` is `colorScheme.surface`; `LocalAbsoluteTonalElevation` sums it through nested surfaces. Newer M3 code picks a `surfaceContainerLowest…Highest` role directly instead.
- `shadowElevation` draws a platform shadow. Its own documentation says to apply it "only when absolutely necessary, such as when the surface requires visual separation from a patterned background".
- Elevation levels: `0`, `1`, `3`, `6`, `8`, `12dp` (levels 0 to 5). Components set their own through `*Defaults`, such as `CardDefaults.cardElevation()`.
- `Card` (filled), `ElevatedCard` (shadow) and `OutlinedCard` (`outlineVariant` border) are the three card treatments; choose one per surface type across the app.

## Shadows and rings on custom surfaces

```kotlin
// Shadow is androidx.compose.ui.graphics.shadow.Shadow, not the text Shadow
val shape = MaterialTheme.shapes.medium
Box(
    Modifier
        .dropShadow(shape, Shadow(radius = 2.dp, spread = (-1).dp, offset = DpOffset(0.dp, 1.dp), color = Color.Black, alpha = 0.06f)) // lift
        .dropShadow(shape, Shadow(radius = 4.dp, offset = DpOffset(0.dp, 2.dp), color = Color.Black, alpha = 0.04f))                   // ambient
        .border(1.dp, Color.Black.copy(alpha = 0.06f), shape) // ring
        .background(MaterialTheme.colorScheme.surface, shape)
)
```

- `Modifier.dropShadow(shape, Shadow(radius, spread, offset, color, alpha))` and `Modifier.innerShadow` draw CSS-like shadows without a graphics layer, including spread. `Shadow.radius` goes to Android's `BlurMaskFilter`, which renders a Gaussian of σ ≈ 0.57 × radius where CSS uses σ = blur ÷ 2: for a CSS blur `b`, start at `radius ≈ 0.88b`.
- `Modifier.shadow(elevation, shape, clip, ambientColor, spotColor)` is the elevation shadow; it clips by default when elevation is above zero.
- `Modifier.border(width, color, shape)` draws inside the bounds, so the ring keeps the size. In dark theme, drop the depth layers and keep a white ring at `0.08`.
- Keep the ring even where shadows render: a shadow-only edge disappears for low-vision users and on dark or busy backgrounds.

## Clipping and image outlines

```kotlin
val shape = MaterialTheme.shapes.medium
val outline = if (isSystemInDarkTheme()) Color.White.copy(alpha = 0.1f) else Color.Black.copy(alpha = 0.1f)
AsyncImage(
    model = url,
    contentDescription = null,
    contentScale = ContentScale.Crop,
    modifier = Modifier.clip(shape).border(1.dp, outline, shape),
)
```

`Modifier.clip(shape)` crops the content to the shape; `Surface` clips its children to its `shape` already. Read dark mode from the app's theme state where it overrides the system setting.

## Optical alignment

[Rule](../../references/surfaces.md#optical-alignment).

- Icon side: `Button(contentPadding = PaddingValues(start = 16.dp, end = 14.dp))` for a trailing icon; M3's `ButtonDefaults.ButtonWithIconContentPadding` already reduces the icon side for a leading icon.
- Play glyph: `Modifier.absoluteOffset(x = 2.dp)`, which stays physical in RTL.
- Fix asymmetric glyphs in the vector drawable's path or viewport.

## Before you finish

| Detection | Fix |
| --- | --- |
| `RoundedCornerShape(<literal>.dp)` where a `MaterialTheme.shapes` slot fits | The shape token |
| Padded parent and child on shape tokens that break the concentric formula | Pick the outer token from the formula |
| `shadowElevation` on surfaces over a plain background | A surface container color role, or `tonalElevation` |
| `Modifier.shadow` with a ring drawn as a second shadow | `Modifier.border` for the ring |
| `AbsoluteRoundedCornerShape` on mirrored UI | `RoundedCornerShape(topStart…)` |
| Image border in a palette gray or the primary color | Black or white at `0.1`, or `outlineVariant` |

Render in light and dark, with dynamic color on and off, and over a busy background.
