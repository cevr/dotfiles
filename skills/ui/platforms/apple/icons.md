# Icons on Apple platforms

SF Symbols implementation of [icons](../../references/icons.md) in SwiftUI. The rules, values and reasons live there; this file maps each one to the API and names where SF Symbols replace a value.

## Platform conventions that win

| Neutral rule | SF Symbols convention |
| --- | --- |
| [Stroke matched to text weight](../../references/icons.md#match-icon-stroke-to-text-weight) | Each of the nine symbol weights (ultralight to black) corresponds to a San Francisco weight. A symbol takes the weight of its `.font` / `.fontWeight`, so set the weight once on the text-and-icon pair instead of choosing a stroke width. |
| Inline size `1–1.25×` the text | A symbol sizes from its font. `.imageScale(.small / .medium / .large)` changes emphasis relative to the cap height without breaking the weight match. |
| Per-size grids | Symbols are variable vector artwork drawn for every size and weight; there is no grid to pick. |
| One library per surface | SF Symbols first. Custom icons are custom symbols built from an exported SF Symbols template, so they inherit weights, scales and rendering modes. |

```swift
// Good: the symbol takes the label's weight and size
Label("New project", systemImage: "plus")
    .font(.body.weight(.semibold))

// Bad: a fixed-size symbol beside Dynamic Type text, in a different weight
HStack {
    Image(systemName: "plus").font(.system(size: 14, weight: .light))
    Text("New project").font(.body.weight(.semibold))
}
```

## Color and state

[Rule](../../references/icons.md#one-glyph-recolored-per-state).

- A symbol takes the foreground style: `.foregroundStyle(.secondary)` at rest, `.tint` or the selected style when active. Controls dim disabled symbols themselves under `.disabled(true)`.
- `.symbolRenderingMode(_:)`: `.monochrome` (one color), `.hierarchical` (one color, layer opacities), `.palette` (one color per layer, via `.foregroundStyle(a, b)`), `.multicolor` (intrinsic colors that carry meaning, such as a red `trash.slash`). Use system colors so symbols adapt to Dark Mode, Increase Contrast and vibrancy; confirm the mode in every context it appears.
- Custom asset icons tint only as templates: `Image("glyph").renderingMode(.template)`, or set Render As: Template Image in the asset catalog.
- `Image(systemName:variableValue:)` shows a level (signal, volume) in one glyph instead of swapping assets.

## Outline and fill

[Rule](../../references/icons.md#outline-default-fill-active). `.symbolVariant(_:)` picks the variant: `.fill`, `.circle`, `.square`, `.slash`, or `.none`.

```swift
Image(systemName: "bookmark")
    .symbolVariant(isSaved ? .fill : .none)
```

Containers choose for you: an iOS tab bar applies `.fill`, a toolbar shows the outline. Leave their choice in place; override with `.environment(\.symbolVariants, …)` only for a deliberate design. `.slash` marks an unavailable item or action.

## State transitions

Symbol effects are the platform's icon animation; they follow the [motion rules](../../references/motion/index.md#icons-cross-fade-on-infrequent-swaps) on when to animate.

| Moment | API |
| --- | --- |
| Swap between two symbols (bookmark, play/pause, copy/copied) | `.contentTransition(.symbolEffect(.replace))` on the image; Magic Replace morphs related symbols, such as `bookmark` to `bookmark.fill` |
| One-shot feedback that an action happened | `.symbolEffect(.bounce, value: trigger)` |
| Ongoing activity until a condition ends | `.symbolEffect(.pulse, isActive: isWorking)`, `.variableColor`, `.rotate`, `.breathe` |
| Drawing a symbol in or out (iOS 26+) | `.drawOn`, `.drawOff` |

HIG: apply symbol animations judiciously, each with a clear purpose. A tab selection swaps instantly. `.symbolEffectsRemoved()` turns effects off for a subtree. Symbol effects ignore Reduce Motion: with it on, bounce, pulse, variable color, rotate, breathe, wiggle, scale and replace all still animate (iOS 27), so gate them on `accessibilityReduceMotion`.

## RTL

[Rule](../../references/icons.md#icons-in-rtl).

- SF Symbols ship right-to-left and localized variants, chosen automatically from the layout direction and language. Use the direction-neutral names (`chevron.forward`, `chevron.backward`, `arrow.forward`) rather than `.left` / `.right` for navigation, so the system flips them.
- Symbols that contain text (signature, rich text, I-beam) have localized versions for Latin, Arabic, Hebrew and other scripts; the system picks them from the device language.
- A custom directional asset: set Direction: Mirrors in the asset catalog, or apply `.flipsForRightToLeftLayoutDirection(true)` in the view. One of the two, never both. UIKit: `imageFlippedForRightToLeftLayoutDirection()`.
- Playback symbols (`play.fill`, `forward.fill`) stay LTR; don't flip them.

## Accessibility

- A `Label` gives an icon-only button its name: `Label("Delete", systemImage: "trash").labelStyle(.iconOnly)` shows only the icon and keeps the VoiceOver name.
- A symbol beside text that already says the same thing is decorative: `.accessibilityHidden(true)`, or `Image(decorative:)` for asset images.
- A bare `Image(systemName:)` gets a label derived from the symbol name, which is rarely the action's name; replace it with `.accessibilityLabel`.

## Before you finish

| Detection | Fix |
| --- | --- |
| `Image(systemName:)` with `.font(.system(size:))` next to Dynamic Type text | A text style font on the pair, `.imageScale` for emphasis |
| `.fontWeight` on the text but not the symbol (or different weights) | One weight on the pair |
| `"chevron.left"`, `"chevron.right"`, `"arrow.left"` for back/forward | `chevron.backward`, `chevron.forward`, `arrow.backward` |
| Two image assets for one icon's states (`star`, `star_selected`) | One symbol with `.symbolVariant` and a foreground style |
| Custom PNG icons | A custom symbol or a vector asset with Preserve Vector Data |
| `.flipsForRightToLeftLayoutDirection(true)` on an asset already set to Mirrors | Keep one |
| Icon-only `Button` with an `Image` label and no `accessibilityLabel` | `Label(…).labelStyle(.iconOnly)` |
