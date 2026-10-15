# Surfaces on Apple platforms

SwiftUI implementation of [surfaces](../../references/surfaces.md), with UIKit and AppKit equivalents where they differ. The rules, values and reasons live there; this file maps each one to the API and names where the Human Interface Guidelines replace a value.

## Platform conventions that win

| Neutral rule | Apple convention |
| --- | --- |
| Corner shape | Continuous corners (the squircle) everywhere. `RoundedRectangle(cornerRadius:)` and `.rect(cornerRadius:)` default to `style: .continuous` in current SDKs; `.circular` is the opt-out. UIKit and AppKit layers: `layer.cornerCurve = .continuous`. |
| [Concentric radius](../../references/surfaces.md#concentric-border-radius) | Let the system derive it: `ConcentricRectangle` (iOS 26+) or `ContainerRelativeShape` inside a `.containerShape(_:)`. Compute by hand only below those versions. |
| [Shadows for elevation](../../references/surfaces.md#shadows-for-elevation-borders-for-structure) | Floating chrome uses Liquid Glass (iOS 26+) or a system material, not a hand-built shadow stack. Content-layer cards may use the shadow ring. |
| Hover shadow | iPadOS pointer: `.hoverEffect(.highlight)` or `.lift` on controls; macOS: `.onHover` drives the hover state. |

## Concentric shapes

```swift
// iOS 26+: a card inside a sheet, corners concentric with the sheet's (or the device's, or a .containerShape)
CardContent()
    .padding()
    .background(ConcentricRectangle(corners: .concentric(minimum: 12), isUniform: true)
        .fill(.background.secondary))
    .padding(8)

// Any version: declare the container's shape, then inset children follow it
VStack { Thumbnail().clipShape(ContainerRelativeShape()) }
    .padding(8)
    .containerShape(.rect(cornerRadius: 20)) // child resolves to an inset of this shape
```

- `ConcentricRectangle` resolves each corner against the container shape: a view extending to the device's rounded corners, a system sheet or popover (automatic), or any ancestor that sets `.containerShape(_:)` with a `RoundedRectangularShape`. A corner far from the container's corner resolves to `0`; `.concentric(minimum:)` keeps it rounded, and `.fixed(_:)` opts a corner out.
- `ContainerRelativeShape` is the inset container shape; with no container shape it falls back to a rectangle.
- Hand-computed (before iOS 26, or with no container): `RoundedRectangle(cornerRadius: inner + padding + border)` on the outer layer, as in the neutral formula. The formula is exact for circular arcs; continuous corners are close enough to judge by eye.

## Shadows and rings

SwiftUI's `.shadow(color:radius:x:y:)` has no spread, so the `1pt` ring is a stroke, not a shadow. Its `radius` is not the CSS blur; start at half the CSS blur value and match by eye (unverified).

```swift
struct RingedCard<Content: View>: View {
    @Environment(\.colorSchemeContrast) private var contrast
    @ViewBuilder var content: Content
    private let shape = RoundedRectangle(cornerRadius: 12)

    var body: some View {
        content
            .background(shape.fill(.background)
                .shadow(color: .black.opacity(0.06), radius: 1, y: 1)   // lift
                .shadow(color: .black.opacity(0.04), radius: 2, y: 2))  // ambient
            .overlay(shape.strokeBorder(.primary.opacity(contrast == .increased ? 0.5 : 0.06),
                                        lineWidth: 1))                  // ring
    }
}
```

- Put shadows on the background shape, not on the content view: `.shadow` on a stack shadows every child glyph separately. Chained `.shadow` modifiers each shadow everything below them, including the earlier shadow, so keep the stack short (compounding unverified).
- Dark mode drops the depth layers and keeps the ring as white at `0.08` (`.primary` resolves to white in dark mode).
- `.strokeBorder` draws inside the shape, so the ring never changes the view's size.
- Increase Contrast: read `colorSchemeContrast` and raise the ring to a visible border, the platform's equivalent of the transparent border under the shadow ring. The `0.5` above stands in for the project's border token.
- UIKit/AppKit: set `layer.shadowPath` to the shape's path so the shadow isn't computed from the layer's alpha every frame.

## Materials and Liquid Glass

The rules for translucency, weight and legibility are in [materials and depth](../../references/motion/gestures.md#materials-and-depth-translucency-conveys-hierarchy). APIs:

| Need | API |
| --- | --- |
| Content-layer blur behind a card or panel | `.background(.regularMaterial, in: .rect(cornerRadius: 16))`; thickness `.ultraThinMaterial`, `.thinMaterial`, `.regularMaterial` (default), `.thickMaterial`, `.ultraThickMaterial`; `.bar` for custom bars |
| Floating control or navigation element (iOS 26+, macOS 26+; not visionOS) | `.glassEffect()` (`.regular`, in a capsule by default), `.glassEffect(.regular, in: .rect(cornerRadius: 16))` |
| Glass over photos or video | `.glassEffect(.clear)`; add a `35%` black dimming layer when the media underneath is bright (HIG) |
| Tinted or pressable glass | `Glass.regular.tint(_:)`, `.interactive()` |
| Several glass elements that blend and morph | Wrap them in `GlassEffectContainer`; `.glassEffectID(_:in:)` and `.glassEffectUnion(id:namespace:)` |
| Glass buttons | `.buttonStyle(.glass)`, `.glassProminent` |
| UIKit / AppKit | `UIVisualEffectView` / `NSVisualEffectView` for materials; Liquid Glass views exist in both (names unverified) |

HIG for Liquid Glass: it is the layer for controls and navigation that floats above content; never use it in the content layer (standard materials go there), use it sparingly, and use `.clear` only over visually rich backgrounds. System bars, sheets, popovers and toolbars adopt it on their own, so a custom bar background usually fights the system. Reduce Transparency and Increase Contrast change both glass and materials automatically; render with them on.

## Image outlines

[Rule](../../references/surfaces.md#image-outlines).

```swift
let shape = RoundedRectangle(cornerRadius: 12)
Image("cover")
    .resizable()
    .scaledToFill()
    .clipShape(shape)
    .overlay(shape.strokeBorder(.primary.opacity(0.1), lineWidth: 1)) // black 0.1 light, white 0.1 dark
```

`.primary` resolves to black in light mode and white in dark, which gives the neutral, untinted edge the rule asks for. A tinted color such as `.secondary` on a colored background, or the accent, fringes.

## Optical alignment

[Rule](../../references/surfaces.md#optical-alignment). SF Symbols are drawn optically balanced and align to text through `Label`; nudge only custom assets.

- Icon-side padding: `.padding(.leading, 16).padding(.trailing, 14)` on a button whose icon trails.
- Custom play glyph: `.offset(x: 2)` inside `.layoutDirectionBehavior(.fixed)` (iOS 17+), so the nudge stays toward the point in RTL.
- Fix an asymmetric custom glyph in the asset (or the custom symbol's template), not in the view.

## Before you finish

| Detection | Fix |
| --- | --- |
| `RoundedRectangle(cornerRadius:, style: .circular)` or `layer.cornerCurve` left at `.circular` | Continuous corners, unless the design asks |
| Padded parent and child with the same corner radius | `ConcentricRectangle`, `ContainerRelativeShape`, or add the padding to the outer radius |
| `.shadow` on a `VStack`/`HStack` of text | Move it to the background shape |
| `.border(Color.gray)` drawing a card edge | `.overlay(shape.strokeBorder(…))` following the corner radius |
| `.glassEffect` on list rows, cards or other content | A standard material, or no material |
| An opaque or hand-blurred custom navigation bar | The system bar, with the scroll edge effect |
| Image outline in `.gray`, the accent or a palette color | `.primary.opacity(0.1)` |

Render in light and dark, with Increase Contrast and Reduce Transparency on, and over both plain and busy backgrounds.
