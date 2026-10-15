# Layout on Apple platforms

SwiftUI implementation of [layout](../../references/layout/index.md), with UIKit and AppKit equivalents where they differ. The rules, values and reasons live there; this file maps each one to the API and names where the Human Interface Guidelines replace a value.

## Platform values that win

| Neutral value | Apple value | Notes |
| --- | --- | --- |
| Layout margin `16pt` | The system margin: `.padding()` with no length, `.scenePadding()`, `List`/`Form` row insets, UIKit `directionalLayoutMargins` | SwiftUI picks a "platform-specific default amount" for the platform and presentation context. On iPhone it renders as `16pt` (unverified per context). Pass an explicit length only for a deliberate design value. |
| Breakpoint widths | Size classes: `horizontalSizeClass` / `verticalSizeClass`, `.compact` or `.regular` | HIG: decide by size class, never by device type or orientation, and consider every combination. |
| Sidebar or tabs at a width | `NavigationSplitView` (collapses to a stack in compact width); `TabView` with `.tabViewStyle(.sidebarAdaptable)` (iOS 18+) | Keep functionality the same as the size class changes; change how much of it is visible. |
| Controls inside safe area | The safe area is applied by default; only backgrounds opt out | |
| Hit-target clearance | `44×44pt` minimum target, owned by [accessibility](../../references/accessibility/hit-areas.md#target-sizes) | |

## Rule to API

| Rule | SwiftUI |
| --- | --- |
| [Group with space](../../references/layout/grouping-and-alignment.md#group-with-space-not-lines) | `VStack(spacing: 24)` of `VStack(spacing: 8)` groups; in lists, `Section` plus `.listSectionSpacing(_:)`; hide separators the spacing already carries with `.listRowSeparator(.hidden)` |
| [Controls distinct from content](../../references/layout/grouping-and-alignment.md#keep-controls-distinct-from-content) | A `Button` with `.buttonStyle(.bordered)`, `.borderedProminent` or `.glass` (iOS 26+), or a toolbar placement; a plain-style button inline in text gets the tint color |
| [Shared edges](../../references/layout/grouping-and-alignment.md#align-to-shared-edges) | One inset on the container (`.padding(.horizontal)`, `.contentMargins`), `HStack(alignment: .firstTextBaseline)`, `.alignmentGuide` for an icon that must sit on the text edge, `Grid` + `GridRow` for label/value columns |
| [Leading and trailing](../../references/layout/grouping-and-alignment.md#leading-and-trailing-for-anything-that-mirrors) | `.leading`/`.trailing` in `Edge`, `Alignment`, `HorizontalAlignment` and `.padding(.leading, …)`; `.multilineTextAlignment(.leading)`; `UnevenRoundedRectangle(topLeadingRadius:…)` |
| [Order by importance](../../references/layout/grouping-and-alignment.md#order-by-importance) | View declaration order is VoiceOver order; reach for `.accessibilitySortPriority` only when the visual order genuinely can't follow it |
| [One primary action](../../references/layout/index.md#one-primary-action-per-view) | One `ToolbarItem(placement: .primaryAction)` or one `.borderedProminent` button; secondary actions in a `Menu` |
| [Hint at hidden content](../../references/layout/spacing-and-adaptivity.md#hint-at-hidden-content) | Peek (below); `DisclosureGroup` for collapsed sections; `.lineLimit(n)` plus a "More" control; leave scroll indicators `.automatic` and use `.scrollIndicatorsFlash(onAppear: true)` (iOS 17+) where scrollability isn't obvious. `.help(_:)` on macOS is hover-only and does not count as the way to full text. |
| [Clearance](../../references/layout/spacing-and-adaptivity.md#borderless-controls-need-more-clearance) | `HStack(spacing: 12)` between bordered buttons; toolbar items get system spacing; `ControlGroup` for related actions |
| [Inset buttons](../../references/layout/spacing-and-adaptivity.md#inset-buttons-from-the-edges) | `.safeAreaInset(edge: .bottom)` (or `.safeAreaBar(edge: .bottom)` on iOS 26+, which adds the scroll edge effect) holding the button with `.frame(maxWidth: .infinity)` and `.padding()` |
| [Content bleeds, controls float](../../references/layout/spacing-and-adaptivity.md#content-bleeds-controls-float) | Below |
| [Hold structure](../../references/layout/spacing-and-adaptivity.md#hold-structure-until-it-breaks) | Below |
| [Growth and clipping](../../references/layout/spacing-and-adaptivity.md#plan-for-growth-and-clipping) | Below |

## Safe areas: content bleeds, controls float

- Content stays inside the safe area by default. Only the background opts out: `.background(.blue)` (a `ShapeStyle` background extends through the safe area by default via `ignoresSafeAreaEdges: .all`), or `.ignoresSafeArea()` on a background view, never on the stack holding text and controls.
- `.ignoresSafeArea(.keyboard)` is the opt-out from keyboard avoidance; leave it off anything holding a focused field.
- `.safeAreaInset(edge:)` adds custom chrome (a sticky header or action bar) and shrinks the safe area for the content, so the scroll view's content and `scrollTo` targets land clear of it. `.safeAreaPadding(_:)` insets the safe area without adding a view.
- `.contentMargins(_:_:for:)` (iOS 17+) insets scroll content while the scroll view itself, its background and its indicators still bleed to the edge; `for: .scrollContent` or `.scrollIndicators` targets one of them.
- Full-screen artwork extends under sidebars, toolbars and tab bars. Where a sidebar or inspector would cover it, `.backgroundExtensionEffect()` (iOS 26+) mirrors and blurs the image beneath them.
- Content scrolls beneath bars. On iOS 26+, the scroll edge effect elevates floating controls above content in place of a solid bar background or a hairline: `.scrollEdgeEffectStyle(.soft | .hard, for: .top)`, `.scrollEdgeEffectHidden(_:for:)`.
- macOS: keep controls and critical information out of the bottom of a window, which people often drag below the screen edge (HIG).

## Adaptivity: hold structure until it breaks

```swift
@Environment(\.horizontalSizeClass) private var sizeClass

var body: some View {
    // Window-level structure follows the size class
    NavigationSplitView {
        Sidebar()
            .navigationSplitViewColumnWidth(min: 220, ideal: 260)
    } detail: {
        Detail()
    }
}
```

- **Component level, container-relative:** `ViewThatFits(in: .horizontal) { wideRow; stackedRow }` picks the first child that fits the space its parent offers. For measured decisions, `.onGeometryChange(for:of:action:)` reads the container size; `GeometryReader` takes all offered space, so wrap only what needs it.
- **Grids:** `LazyVGrid(columns: [GridItem(.adaptive(minimum: 180))])` adds columns as width allows (the feed pattern). `Grid` with `GridRow` aligns columns across rows, such as label/value forms; `.gridCellColumns(_:)` spans.
- **iPad and Mac:** `NavigationSplitView` shows two or three columns in regular width and collapses to a `NavigationStack` in compact width; `.navigationSplitViewStyle(.balanced | .prominentDetail)` decides whether the detail shrinks or is overlaid. Resizable windows (iPad windowing, macOS) cross size classes at runtime, so never cache a layout decision.

## Growth and clipping

- Text grows with Dynamic Type. Never give a text container a fixed `.frame(height:)`; use `.frame(minHeight:)` and let it scroll where it must cap.
- In an `HStack`, give the text column `.layoutPriority(1)` so a long name wraps or truncates instead of pushing the trailing button off-screen; mark the button `.fixedSize()`.
- `.fixedSize(horizontal: false, vertical: true)` lets a `Text` wrap to its full height inside a parent that proposes a fixed height.
- At accessibility text sizes, switch rows to stacks: `@Environment(\.dynamicTypeSize)` with `.isAccessibilitySize`, or `ViewThatFits`. Scale custom spacing with `@ScaledMetric`.
- Sheets: put the actions in the sheet's `.toolbar` (confirmation and cancellation placements), so they stay visible however tall the content grows; `.presentationDetents` (iOS) sets the resting heights.

## Mirroring for RTL

- `HStack`, `Alignment.leading` and `.padding(.leading)` mirror automatically. Hand-placed geometry (`.position`, `.offset(x:)`, `Path`, `Canvas`, `GeometryReader` math) is in absolute coordinates: check it under `.environment(\.layoutDirection, .rightToLeft)` in a preview (exact mirroring of `.offset` unverified).
- `.flipsForRightToLeftLayoutDirection(true)` mirrors a custom image or shape whose meaning is directional. `.layoutDirectionBehavior(.fixed)` (iOS 17+) keeps a subtree in LTR, such as a media scrubber; `.mirrors` opts a shape in.
- Progress-like controls (`Slider`, `ProgressView`, `Gauge`) mirror on their own. Directional icon rules are in [Apple icons](icons.md#rtl).

## Peeking carousel

```swift
ScrollView(.horizontal) {
    LazyHStack(spacing: 12) {
        ForEach(items) { item in
            Card(item)
                // container width (minus the 24pt safe-area padding) + 12 gap - 24 peek
                .containerRelativeFrame(.horizontal) { length, _ in length - 12 }
        }
    }
    .scrollTargetLayout()
}
.scrollTargetBehavior(.viewAligned)
.safeAreaPadding(.horizontal, 24)
```

`.containerRelativeFrame` sizes from the container minus its safe-area insets, which is why the inset is `.safeAreaPadding` and not `.padding`.

## Before you finish

| Detection pattern | Fix |
| --- | --- |
| `.padding(.left …)`, `Alignment.left`, `.multilineTextAlignment(.left)` or `x:` math on mirrored UI | `.leading`/`.trailing`, or a `layoutDirection` check |
| `.ignoresSafeArea()` on a stack holding text or controls | Move it to the background view |
| `.frame(height:)` with a literal on a view holding `Text` | `.frame(minHeight:)`, or a scroll view where it caps |
| `UIDevice.current.userInterfaceIdiom == .pad` or `UIScreen.main.bounds` deciding layout | `horizontalSizeClass`, `ViewThatFits` or the container size |
| `HStack` with a long `Text` beside a button and no `.layoutPriority` | `.layoutPriority(1)` on the text column |
| `.scrollIndicators(.hidden)` on content whose scrollability isn't obvious | `.automatic`, or flash them on appear |
| Custom bottom bar in a `VStack` below a `ScrollView` | `.safeAreaInset(edge: .bottom)` / `.safeAreaBar` |

Verify in previews at the smallest iPhone, iPad split view widths (or a narrow and a wide macOS window), the largest accessibility Dynamic Type size and a right-to-left locale.
