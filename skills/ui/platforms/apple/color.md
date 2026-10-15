# Color on Apple platforms

How the [color](../../references/color/index.md) rules are built in SwiftUI, with UIKit where it differs. The rules, thresholds and ramp properties live there; this file maps them to the system's colors and APIs and states where Apple's conventions win.

## System colors first

The semantic system colors already carry light, dark and increased-contrast variants, and in dark mode the base and elevated backgrounds that tell a sheet from the screen beneath it. Use them before building a palette, and never hard-code their values, which change between releases. They fill the neutral [role inventory](../../references/color/token-naming.md#the-role-inventory):

| Role | SwiftUI | UIKit |
| --- | --- | --- |
| Page background | `Color(.systemBackground)`; grouped lists `Color(.systemGroupedBackground)` | `.systemBackground`, `.systemGroupedBackground` |
| Surface, nested surface | `Color(.secondarySystemBackground)`, `Color(.tertiarySystemBackground)` (grouped: `.secondarySystemGroupedBackground`, …) | Same names |
| Raised (menus, sheets, popovers) | The system background: dark mode switches it to the elevated variant on its own | Same |
| Sunken (inputs, wells), control fills | `Color(.systemFill)` … `Color(.quaternarySystemFill)` | `.systemFill` … `.quaternarySystemFill` |
| Text primary, secondary, tertiary | `.foregroundStyle(.primary)`, `.secondary`, `.tertiary` (`.quaternary`, `.quinary` beyond) | `.label`, `.secondaryLabel`, `.tertiaryLabel`, `.quaternaryLabel` |
| Placeholder text | `Color(.placeholderText)` | `.placeholderText` |
| Separator | `Color(.separator)`; `Color(.opaqueSeparator)` when nothing should show through | `.separator`, `.opaqueSeparator` |
| Link | `Color(.link)` | `.link` |
| Accent | `.tint(_:)` once near the root, or the `AccentColor` asset; read with `Color.accentColor` | `tintColor` |
| Status | `.red`, `.orange`, `.yellow`, `.green`, … system colors | `.systemRed`, … |

In SwiftUI prefer the hierarchical styles (`.primary` … `.quinary`) for foregrounds: on a material they render with vibrancy, which a fixed `Color(.secondaryLabel)` does not. The HIG's own version of [use a token only in its role](../../references/color/index.md#use-a-token-only-in-its-role): never a separator as text or a label color as a background.

## Tokens

A custom role is an asset-catalog color set named for the role (`AccentSolid`, `TextOnAccent`), not the hue. Xcode generates a symbol for it, used as `Color(.accentSolid)`. Each set holds the four values the neutral [light, dark and increased contrast](../../references/color/color-usage.md#light-dark-and-increased-contrast) rule asks for: set Appearances to Any, Dark and check High Contrast.

Asset catalogs cannot point one color at another, so the primitive tier lives in code and the semantic tier resolves per trait:

```swift
extension UIColor {
  static let blue200 = UIColor(red: 0.749, green: 0.859, blue: 0.996, alpha: 1)  // #bfdbfe, primitives
  // blue400, blue600, blue900 …
}
extension Color {
  static let accentSolid = Color(uiColor: UIColor { t in
    switch (t.userInterfaceStyle, t.accessibilityContrast) {
    case (.dark, .high): .blue200
    case (.dark, _): .blue400
    case (_, .high): .blue900
    default: .blue600
    }
  })
}
```

## Appearances

- **Light and dark.** Dynamic colors (system, asset, or a `UIColor` provider) switch on their own; that is the one [switching mechanism](../../references/color/palette-generation.md#one-switching-mechanism). A user-facing theme override sets `.preferredColorScheme(_:)` at the root. Branching on `@Environment(\.colorScheme)` to pick colors is a second mechanism.
- **Increase Contrast.** Asset High Contrast variants and system colors respond automatically. Custom drawing reads `@Environment(\.colorSchemeContrast) == .increased`; UIKit reads `traitCollection.accessibilityContrast == .high`.
- **Reduce Transparency.** Materials turn opaque; read `@Environment(\.accessibilityReduceTransparency)` for custom translucent surfaces and check contrast both ways.
- **Single-appearance apps** still supply light and dark values: the HIG asks for both so Liquid Glass can adapt.
- The HIG asks for at least 4.5:1 and recommends 7:1 for custom foreground and background pairs, especially in small text. That is stricter than the neutral [WCAG AA](../../references/color/contrast.md#wcag-2-thresholds) for custom colors and wins here.

## Formats and gamut

Apple stores sRGB or Display P3 components, not OKLCH. Build the ramp in OKLCH with a [color library](../../references/color/palette-generation.md#use-a-color-library) and paste the components.

| Need | API |
| --- | --- |
| sRGB value | `Color(.sRGB, red: 0.067, green: 0.678, blue: 0.196)`; `UIColor(red:green:blue:alpha:)` |
| P3 value | `Color(.displayP3, red:green:blue:)`; `UIColor(displayP3Red:green:blue:alpha:)` |
| sRGB base with a P3 enhancement | Color set Gamut: "sRGB and Display P3", one value per gamut |
| Derived color | `Color.mix(with:by:in:)` (iOS 18), perceptual by default; resolved at render time |
| Gradient interpolation | `Gradient(colors:).colorSpace(.perceptual)` (an `AnyGradient`), drawn with `.linearGradient(_:startPoint:endPoint:)`; `.device` is the sRGB look |

## Measuring contrast

Measure the resolved color, never the name. `Color.resolve(in: environment)` returns a `Color.Resolved` with components for the current appearance; UIKit's `resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark))` does the same per trait. Xcode's Environment Overrides switch appearance and Increase Contrast in a running app, and Accessibility Inspector's Color Contrast Calculator samples rendered pairs. Text on a material or Liquid Glass takes its background from the content behind it, so measure over the lightest and darkest content that scrolls there.

## Auditing

To [inventory a palette](../../references/color/palette-structure.md#auditing-an-existing-palette), grep for `Color(red:`, `Color(.sRGB`, `Color(.displayP3`, `UIColor(red:`, `#colorLiteral`, hex initializer extensions (`Color(hex:`), string-named assets (`Color("`) and every `.colorset` folder under `*.xcassets`.

## Before you finish

| Pattern | Fix |
| --- | --- |
| `Color(red:green:blue:)` or a hex initializer in a view | A semantic system color or a role color set |
| `.black` or `.white` for text or a screen background | `.primary`, `Color(.systemBackground)` |
| `.gray` or `.opacity(0.6)` for secondary text | `.secondary` |
| A custom color set with only the Any appearance | Add Dark and the High Contrast variants |
| `colorScheme == .dark ? a : b` to choose a color | A dynamic color |
| A custom background on a sheet or popover | `Color(.systemBackground)`, so dark mode elevates it |
| `Color(.separator)` as a text color | The label hierarchy |
| Several different `.tint` colors across peer controls | One accent at the root |
