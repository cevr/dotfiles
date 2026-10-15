# Surfaces

Visual polish for surfaces, with the exact value each detail takes: concentric radius, optical alignment, shadows and rings, image outlines. It applies once the underlying interaction is sound, and a polish finding never outranks a broken interaction.

Implementation: [web](../platforms/web/surfaces.md) · [Apple](../platforms/apple/surfaces.md) · [Android](../platforms/android/surfaces.md)

## Exact values, optional polish

The values here, in [icons](icons.md) and in [motion](motion/index.md) are exact, not ranges to approximate. `cubic-bezier(0.2, 0, 0, 1)` is not `cubic-bezier(0.4, 0, 0.2, 1)`, and `0.96` is not `0.95`. The optical nudges and the concentric padding cutoff are the exceptions. They are starting points, judged by eye.

Keep the project's component library, tokens and density, and match its motion language wherever no rule gives a value. A deliberate and consistent project convention, such as a style with no shadows, is a preference and not a finding. The same detail done two ways within the project is a finding. Platform conventions, such as Apple's continuous corners and materials or Material 3's shape scale and tonal elevation, come before the values here; each platform file says where.

Text wrapping, font rendering, tabular numbers and text spacing belong to [typography](typography/index.md). Hit areas, keyboard support, semantics and the reduced-motion requirement belong to [accessibility](accessibility/index.md). Grouping, section spacing, breakpoints and spatial RTL belong to [layout](layout/index.md), except directional icon mirroring, which is in [icons](icons.md#icons-in-rtl). Color tokens and contrast measurement belong to [color](color/index.md). Animation, transitions and their exact values belong to [motion](motion/index.md); translucent materials and depth belong to [gestures and fluid motion](motion/gestures.md#materials-and-depth-translucency-conveys-hierarchy).

## Concentric border radius

Where nested surfaces share a visible, even inset, the outer radius is the inner radius plus the padding plus any border width. Past `24pt` of padding, or where the padding is deliberately asymmetric, treat the layers as separate surfaces and keep each one's radius token.

```
outerRadius = innerRadius + padding + borderWidth
```

A `12pt` inner radius inside `8pt` of padding takes a `20pt` outer radius. The same radius on both layers is the failure: the gap between the corners swells at each corner. Where the outer radius is fixed by the system (a device corner, a sheet, a window), derive the inner one: `innerRadius = outerRadius − padding`.

## Optical alignment

Where geometric centering looks off, nudge by eye. Give a button `2pt` less padding on its icon side, shift a play triangle toward its point and fix asymmetric glyphs in the asset itself.

### Buttons with text and an icon

Start the icon side at `2pt` less padding than the text side, such as `16pt` on the text side and `14pt` on the icon side, then judge by eye. Equal padding pushes the icon visually outward.

### Play button triangles

A triangle's geometric center sits behind its visual center, so shift it `2pt` toward its point. The offset is physical on purpose: playback icons never mirror.

### Asymmetric icons

Stars, arrows and carets carry uneven visual weight. Fix the drawing's bounds or path in the asset, so the component needs no extra offset. Where the asset cannot change, nudge its wrapper by `1pt`.

## Shadows for elevation, borders for structure

Where a border exists only to create depth, replace it with a layered transparent shadow. Keep borders on dividers, separators, table cells and selected states. Keep them on form inputs too, whose boundary needs 3:1 non-text contrast under [accessibility](accessibility/forms.md). Focus rings belong to [accessibility](accessibility/focus-and-keyboard.md) as well.

Where a shadow alone draws a surface's edge, the high-contrast modes still need an edge: keep a transparent border the same width under the shadow ring, which those modes paint, or switch to a visible border when the platform reports increased contrast. The transparent border also keeps the box the same size as the border it replaces.

### Shadow recipes

Values in `pt`; `x`, `y`, `blur`, `spread`, then the color as black or white at an alpha. The blur is the CSS blur radius; other platforms' blur parameters are not the same unit, so match the rendered result by eye.

**Light mode** has three layers. The first acts as a `1pt` ring, the second adds lift and the third ambient depth:

| Layer | Rest | Hover |
| --- | --- | --- |
| Ring | `0 0 0 1` black `0.06` | black `0.08` |
| Lift | `0 1 2 -1` black `0.06` | black `0.08` |
| Ambient | `0 2 4 0` black `0.04` | black `0.06` |

**Dark mode** keeps one white ring, because depth shadows vanish on dark backgrounds: `0 0 0 1` white `0.08` at rest, white `0.13` on hover.

The rest-to-hover change transitions over `150ms` `ease-out`, and only on pointers that can hover.

## Image outlines

Give content images a `1pt` outline drawn just inside the edge, so it never changes the image's size and follows its corner radius. Use black at `0.1` alpha in light mode and white at `0.1` in dark. Never use a palette near-black, a tinted neutral or the accent color, because the tint shows as a colored fringe on the image edge. Skip transparent artwork such as logos and illustrations.

## Reporting

**Severity.** `HIGH` breaks an interaction, as a hover state stuck after a tap does. Two of the [cross-discipline review](../workflows/review.md)'s escalation triggers land in this polish domain and are `HIGH` on sight. One is motion that ignores the reduce-motion setting, and the other is a state change carried by motion alone; both are judged under [motion](motion/index.md). `MEDIUM` is a visible inconsistency in surfaces, icons or motion. `LOW` is isolated polish.

**Verification.** Without rendering, read every state the component defines from the code, such as hover, pressed, selected, loading and empty. With rendering, walk each state in light and dark and with increased contrast. Report every check you could not run as `Not verified`.

**Format.** Group findings under the principle each violates, ordered by severity, one row per root cause listing every location it appears in:

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |

`Location` is `path/to/file:line`. `Why` names the principle and the user impact.

End with `Block` when any `HIGH` remains, `Approve` otherwise, leaving the rest in the table as work to do. Never `Approve` coverage you did not inspect. With nothing to report, state "No actionable UI-polish findings" and report verification.

Detection patterns to check before finishing are in each platform file: [web](../platforms/web/surfaces.md#before-you-finish) · [Apple](../platforms/apple/surfaces.md#before-you-finish) · [Android](../platforms/android/surfaces.md#before-you-finish). Icon checks are in [icons](icons.md#before-you-finish). Motion checks are in [motion](motion/index.md).
