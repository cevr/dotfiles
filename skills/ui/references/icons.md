# Icons

Icon stroke weight, sizing, state colors, variants and RTL mirroring. The exact-values posture and the ownership boundaries in [surfaces](surfaces.md#exact-values-optional-polish) apply here too. Animated icon swaps are in [motion](motion/index.md#icons-cross-fade-on-infrequent-swaps). Accessible names for icon-only buttons belong to [accessibility](accessibility/index.md).

Implementation: [web](../platforms/web/icons.md) · [Apple](../platforms/apple/icons.md) · [Android](../platforms/android/icons.md)

## Match icon stroke to text weight

An icon's rendered stroke tracks the weight of the text beside it, from `1.5pt` at 400 to `2.5pt` at 700.

| Adjacent text | Rendered stroke width |
| --- | --- |
| Regular (400), 14–16pt | `1.5pt` |
| Medium or semibold (500–600) | `2pt` |
| Bold (700), or an emphasized standalone icon | `2.5pt` |

The widths are rendered points. A 24pt-grid icon drawn at 16pt scales its stroke by 16/24, so a stroke of `2` in the source paints about `1.33pt`; use the icon system's absolute or non-scaling stroke option. Icon systems with weights matched to the system font (SF Symbols, Material Symbols) replace this table: set the icon's weight to the text's weight.

A `2pt` stroke beside a semibold label is right; a `1.5pt` stroke beside a bold label looks faint.

- **One library per surface.** Never mix icon libraries on one toolbar. Where the library has no stroke variants, keep its native stroke and use size or color for emphasis.
- **Size inline icons at 1–1.25×** the adjacent font size, so the pair scales together, including with the user's text size.

## One glyph, recolored per state

Icons take the current content color and get hover, selected and disabled states from color and opacity (disabled at `0.4`), never from separate assets. Strip hardcoded fills such as `#666` to the current color when importing icons. Use the project's color tokens for each state.

## Outline default, fill active

Where an icon set offers outline and filled variants, use them as a state pair, never interchangeably:

| Variant | Use for |
| --- | --- |
| Outline | Default state in toolbars, list rows and inline text |
| Fill | Selected or active state, such as the active tab, a toggled bookmark or a liked heart |

Filled everywhere leaves the active tab with no state signal. Some platform containers choose the variant themselves (an iOS tab bar fills; a toolbar outlines); let them.

Cross-fade the swap with the icon values in [motion](motion/index.md#icons-cross-fade-on-infrequent-swaps) only where the change is infrequent, such as a bookmark or a like. An active tab swaps instantly.

## Design at render size

- Test every icon at the smallest size it renders, often `16pt`. It must stay recognizable there.
- Prefer a simplified glyph for small contexts over scaling down detailed artwork.
- Where the set ships per-size grids or optical sizes, such as `16`, `20` and `24`, use the one that matches the render size. A 24pt drawing scaled to 16pt lands off the pixel grid and renders soft.
- Always vector, never raster.

## Icons in RTL

In a right-to-left layout, flip icons whose meaning is tied to reading direction, and leave the rest alone:

| Flip | Don't flip |
| --- | --- |
| Back and forward arrows, navigation chevrons | Logos and brand marks |
| Text-block glyphs for alignment, lists and indent | Checkmarks and other universal marks |
| Speaker and volume waves | Physical objects such as clocks, cups and pencils |
| Directional glyphs such as "send" | Media playback, which stays LTR by convention |

Use one mechanism per element. Two flips on one icon, such as an auto-mirrored asset inside a manually flipped container, compound back to unflipped.

Analyze composite icons part by part. A badge or slash overlay may keep its position while the base glyph flips. Icons that contain text, such as a signature or rich-text glyph, need a localized version rather than a flip.

## Before you finish

| Check | Look for |
| --- | --- |
| Hardcoded icon color | A fill or stroke literal inside the icon asset, or a fixed tint instead of the current content color |
| Stroke mismatch | Icon weight lighter or heavier than the adjacent text |
| Variant misuse | Filled icons in a default state, or no variant change on the selected one |
| RTL | A directional glyph with no mirroring, or a logo, checkmark or playback icon that mirrors |

The platform detection patterns are in [web](../platforms/web/icons.md#before-you-finish) · [Apple](../platforms/apple/icons.md#before-you-finish) · [Android](../platforms/android/icons.md#before-you-finish). Report findings with the severity and format in [surfaces](surfaces.md#reporting).
