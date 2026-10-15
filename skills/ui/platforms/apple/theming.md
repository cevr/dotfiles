# Theming on Apple Platforms

SwiftUI (with UIKit and AppKit where they appear) for the rules in [theming](../../references/theming.md), plus the Apple side of [design systems](../../references/design-system.md) and [interface judgment](../../references/interface-judgment.md).

## Where the System Lives

| Neutral | Apple |
| --- | --- |
| [Token definitions](../../references/theming.md#find-the-system-first) | Color sets in the asset catalog (each with Any, Dark, and High Contrast appearances), `Color` / `ShapeStyle` extensions naming them, `Font` extensions over Dynamic Type text styles, and custom `EnvironmentValues` for anything else |
| Mode mechanism | The system appearance, read as `@Environment(\.colorScheme)`; an in-app override through `.preferredColorScheme` ([below](#mode-ownership)) |
| Shared components | The project's `ButtonStyle`, `LabelStyle`, `ToggleStyle`, and wrapper views; the system controls they style |
| Semantic system colors | `Color.primary`, `.secondary`, `.tint`, the `.background` and hierarchical (`.secondary`, `.tertiary`) shape styles; UIKit's `Color(.systemBackground)`, `Color(.label)` |

## Colors as Named Roles

Literal colors (`Color(red:green:blue:)`, `Color.blue`, `UIColor(hex:)`) at a use site are the [palette bypass](../../references/theming.md#color-by-role-not-palette). Define each role once in the asset catalog, then name it:

```swift
// Xcode 15+ generates ColorResource symbols for asset-catalog colors.
extension ShapeStyle where Self == Color {
    static var brandPrimary: Color { Color(.brandPrimary) }
    static var onBrandPrimary: Color { Color(.onBrandPrimary) }
}

Text("Publish").foregroundStyle(.onBrandPrimary)
```

The `ShapeStyle` extension makes the role work with `.foregroundStyle`, `.background`, and `.fill` as well as `Color` APIs. The asset catalog holds every appearance, so no use site checks `colorScheme` to pick a color.

`.tint` sets the accent for controls in a subtree; the app-wide accent is the `AccentColor` asset.

## Custom Tokens in the Environment

Spacing, radii, motion, or a whole brand theme that `Color` can't carry go in the environment with `@Entry`:

```swift
struct Theme { var cornerRadius: CGFloat = 12; var spacing: CGFloat = 16 }
extension EnvironmentValues { @Entry var theme = Theme() }

// At the root: .environment(\.theme, brandTheme)
// In a view:   @Environment(\.theme) private var theme
```

Static values that never vary by subtree can be plain `static let` members instead.

## Variants at the Source

The [customization ladder](../../references/theming.md#customizing-a-component-library) on Apple:

| Step | Apple |
| --- | --- |
| Theme values | Asset-catalog colors, `.tint`, `Font` extensions |
| Built-in variants and sizes | `.buttonStyle(.bordered)`, `.borderedProminent`, `.controlSize(.small)`, `.buttonBorderShape(.capsule)`, `role: .destructive` |
| A new variant | A `ButtonStyle`, `LabelStyle`, or `ToggleStyle` with a static member, applied with `.buttonStyle(.brand)` |
| A wrapper | A view composing the styled controls |

```swift
struct BrandButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(.onBrandPrimary)
            .padding(.horizontal, 16)
            .frame(minHeight: 44)
            .background(configuration.isPressed ? Color(.brandPrimaryPressed) : Color(.brandPrimary),
                        in: .capsule)
            .opacity(isEnabled ? 1 : 0.4)
    }
}
extension ButtonStyle where Self == BrandButtonStyle { static var brand: Self { .init() } }
```

A style set on a container (`.buttonStyle(.brand)` on a `VStack`) reaches every button inside it. Call-site modifiers handle layout (`.frame`, `.padding`, alignment); a `.foregroundStyle` or `.font` on one call site is a one-off restyle.

## States

| State | Apple |
| --- | --- |
| Pressed | `configuration.isPressed` in a `ButtonStyle` |
| Disabled | `.disabled(_:)`; read `@Environment(\.isEnabled)` in the style |
| On / checked | `configuration.isOn` in a `ToggleStyle` |
| Focus | `@FocusState`, `.focused(_:)`; the system focus effect on keyboard, iPad pointer, macOS, and tvOS |
| Hover | `.onHover` (macOS, iPadOS pointer), `.hoverEffect` (iPadOS, visionOS) |
| Invalid | No system modifier: carry it in the field's style and in its accessibility value |

## Motion Tokens

Name curves once (`extension Animation { static let control = Animation.snappy(duration: 0.2) }`) and read `@Environment(\.accessibilityReduceMotion)` where the motion domain says to reduce. Sheets, popovers, and alerts own their presentation and dismissal animation; leave it alone.

## Mode Ownership

`.preferredColorScheme(_:)` sets the scheme for the nearest enclosing presentation (window, sheet, popover), and the value propagates up from wherever it is applied. Give one owner the in-app appearance setting: apply it once on the root view of each scene, passing `nil` for "follow the system". A `.preferredColorScheme` deep in a screen silently flips its whole window. In UIKit, the owner sets `overrideUserInterfaceStyle` on the window.

## Overlays and New Roots

Applies [overlays carry the theme](../../references/theming.md#overlays-carry-the-theme):

| Surface | Environment |
| --- | --- |
| `sheet`, `fullScreenCover`, `popover`, `alert`, `confirmationDialog`, `inspector` | Inherit the presenting view's environment, custom `@Entry` values included (unverified for every OS version; check on the oldest deployment target) |
| A new scene or window (`WindowGroup`, `Window`, `openWindow`) | Starts from the scene's root: apply the theme modifiers in each scene's root view |
| `UIHostingController`, `NSHostingController`, `UIHostingConfiguration` | Start a new SwiftUI root that inherits only system traits: re-apply `.environment(\.theme, …)`, `.tint`, and the scheme |
| UIKit or AppKit views inside SwiftUI | Read the trait collection or `effectiveAppearance`, not the SwiftUI environment |

## Mode Edges

The Apple [mode edges](../../references/theming.md#mode-edges-the-theme-doesnt-reach):

- **Launch screen**: the `UILaunchScreen` Info.plist dictionary's `UIColorName` names an asset-catalog color, so the first frame matches each mode.
- **App icon**: provide the dark and tinted appearances in the icon asset (iOS 18+).
- **Core Animation colors**: `layer.borderColor = UIColor.separator.cgColor` freezes the color at assignment. Re-resolve on appearance change (`registerForTraitChanges` on iOS 17+, `resolvedColor(with:)`; on macOS, `performAsCurrentDrawingAppearance` from `viewDidChangeEffectiveAppearance`).
- **Rendered images and snapshots** taken in one mode stay in that mode; regenerate them on change.

## Design System

Apple specifics for [design systems from a spec](../../references/design-system.md):

| Step | Apple |
| --- | --- |
| [Map tokens](../../references/design-system.md#2-map-tokens-to-theme-roles) | A spec color becomes an asset-catalog color set with Any, Dark, and High Contrast values; other tokens become `@Entry` values or static members |
| Text styles | One `Font` per type token built with `Font.custom(_:size:relativeTo:)`, so it still scales with Dynamic Type. `.tracking(_:)` takes points: multiply the spec's em tracking by the size |
| Fonts | Font files in the app target, listed in `UIAppFonts` (iOS) or under `ATSApplicationFontsPath` (macOS) |
| Variants | Each spec recipe is a `ButtonStyle` / `LabelStyle` / `ToggleStyle`; keep system roles (`.destructive`, `.cancel`) |
| Control heights | One `minHeight` per control size, shared by buttons and fields; never below the [target size](../../references/accessibility/hit-areas.md#target-sizes) |

The design system page is a **preview catalog**: `#Preview` blocks, one per foundation (color pairs, type specimen, radius and elevation) and per component, each a grid of variants × states. Show every mode in the catalog (`.preferredColorScheme(.dark)` on a duplicate preview, or Xcode's canvas Variants), plus the largest accessibility Dynamic Type size (`.dynamicTypeSize(.accessibility3)`).

Pin states without interaction by giving the style an input the preview can set, alongside the live one:

```swift
extension EnvironmentValues { @Entry var pinnedPressed = false }
// In the style: let pressed = configuration.isPressed || pinnedPressed

#Preview("Button states") {
    VStack {
        Button("Publish") {}
        Button("Publish") {}.environment(\.pinnedPressed, true)
        Button("Publish") {}.disabled(true)
    }
    .buttonStyle(.brand)
}
```

## Interface Judgment

- **The navigation bar already holds the title.** `.navigationTitle` names the screen; a second large heading at the top of the content repeats it ([start with what the app provides](../../references/interface-judgment.md#start-with-what-the-app-already-provides)).
- **Read-only values render as metadata.** In a `Form` or `List`, a fixed value is `LabeledContent("Created", value: date, format: .dateTime)`; only editable values get a control ([visual cues match behavior](../../references/interface-judgment.md#keep-visual-cues-consistent-with-behavior)).
