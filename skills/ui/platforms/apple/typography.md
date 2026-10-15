# Typography on Apple platforms

How the [typography](../../references/typography/index.md) rules are built in SwiftUI, with UIKit and AppKit where they differ. The rules and their reasons live there; this file maps each to an API and states where Apple's own values win.

## The system scale wins

Use the Dynamic Type text styles, not the neutral [type scale](../../references/typography/spacing-and-sizing.md#type-scale). Each style carries size, leading and weight, scales with the user's text size and gets Bold Text for free. Body is `17pt` on iOS, not `16pt`. iOS and iPadOS sizes at the default (Large) setting, from the HIG:

| Role | `Font.TextStyle` | Size / leading (pt) | Weight | Emphasized | macOS size / leading |
| --- | --- | --- | --- | --- | --- |
| Display | `.largeTitle` | 34 / 41 | Regular | Bold | 26 / 32 |
| Title | `.title` | 28 / 34 | Regular | Bold | 22 / 26 |
| | `.title2` | 22 / 28 | Regular | Bold | 17 / 22 |
| Heading | `.title3` | 20 / 25 | Regular | Semibold | 15 / 20 |
| | `.headline` | 17 / 22 | Semibold | Semibold | 13 / 16 (Bold) |
| Body | `.body` | 17 / 22 | Regular | Semibold | 13 / 16 |
| | `.callout` | 16 / 21 | Regular | Semibold | 12 / 15 |
| | `.subheadline` | 15 / 20 | Regular | Semibold | 11 / 14 |
| Caption | `.footnote` | 13 / 18 | Regular | Semibold | 10 / 13 |
| | `.caption` | 12 / 16 | Regular | Semibold | 10 / 13 |
| | `.caption2` | 11 / 13 | Regular | Semibold | 10 / 13 |

At AX5, the largest accessibility size, `.body` is `53pt`. The HIG minimum is `11pt` on iOS and `10pt` on macOS; macOS has no Dynamic Type. visionOS adds `.extraLargeTitle` and `.extraLargeTitle2`. Emphasize within a style with `.bold()` or `.fontWeight(_:)`, which the HIG's emphasized weight column describes.

Leave tracking alone on SF. The system font tracks itself at every size: `-0.43pt` at `17pt`, `+0.38pt` at `28pt`. The neutral [letter-spacing by size](../../references/typography/index.md#letter-spacing-by-size) values apply only to a custom face.

## Rule to API

| Rule | SwiftUI | UIKit / AppKit |
| --- | --- | --- |
| [Type scale](../../references/typography/index.md#use-a-type-scale-with-semantic-names) | `.font(.body)`, `.font(.system(.title, design: .serif, weight: .semibold))` | `UIFont.preferredFont(forTextStyle:)` with `adjustsFontForContentSizeCategory = true` |
| Custom face that scales | `.font(.custom("Satoshi-Medium", size: 15, relativeTo: .subheadline))` | `UIFontMetrics(forTextStyle: .subheadline).scaledFont(for:)` |
| A non-text metric (icon, padding) that tracks text size | `@ScaledMetric(relativeTo: .body) var icon = 24.0` | `UIFontMetrics.default.scaledValue(for:)` |
| [Line-height by role](../../references/typography/index.md#line-height-by-role) | `.lineHeight(.multiple(factor: 1.5))` (iOS 26+); earlier, `Font.leading(.tight)` / `.loose` or `.lineSpacing(_:)`, which adds points between lines rather than setting a ratio | `NSParagraphStyle.lineHeightMultiple` |
| [Letter-spacing](../../references/typography/index.md#letter-spacing-by-size) (custom face) | `.tracking(_:)` in points: size × em value | `.kern` attribute |
| [Tabular numbers](../../references/typography/index.md#tabular-numbers-on-changing-values) | `.monospacedDigit()` | Feature `kNumberSpacingType` / `kMonospacedNumbersSelector` |
| Small caps | `Font.smallCaps()`, `.lowercaseSmallCaps()`, `.uppercaseSmallCaps()` | Feature settings on `UIFontDescriptor` |
| Super and subscript | `.baselineOffset(_:)` with a smaller font; real `sups`/`subs` glyphs only through feature settings | `UIFontDescriptor` feature settings |
| Raw tags (`ss01`, `GRAD`) | `Font(_: CTFont)` from a descriptor, below | `UIFontDescriptor` with `.featureSettings` (`kCTFontOpenTypeFeatureTag`) or `kCTFontVariationAttribute` |
| Width, family | `.fontWidth(.condensed)` (`.compressed`, `.condensed`, `.standard`, `.expanded`); `.fontDesign(.serif)` for New York, `.rounded`, `.monospaced` for SF Mono | `UIFontDescriptor.withDesign(_:)` |
| [Truncate](../../references/typography/index.md#truncate-with-a-way-back) | `.lineLimit(1)` with `.truncationMode(.tail)` (`.middle` for file names and IDs); `.lineLimit(3, reservesSpace: true)` to hold height | `numberOfLines`, `lineBreakMode = .byTruncatingTail` |
| [Natural case](../../references/typography/index.md#natural-case-typographic-punctuation) | `.textCase(.uppercase)` | Uppercase at render with `uppercased(with: locale)` |
| [Underlines](../../references/typography/index.md#underlines-from-the-font) | `.underline(pattern: .dot, color: .secondary)` | `.underlineStyle` attribute |
| Start alignment | `.multilineTextAlignment(.leading)` (mirrors in RTL) | `.natural` alignment |
| [Wrap deliberately](../../references/typography/index.md#wrap-deliberately) | No balance or orphan control on `Text`; `.fixedSize(horizontal: true, vertical: false)` keeps a label on one line | `NSParagraphStyle.lineBreakStrategy = .pushOut` keeps a lone word off the last line |
| Hyphenation | None: `Text` ignores an `AttributedString` paragraph style's hyphenation; wrap a `UILabel` | `NSParagraphStyle.usesDefaultHyphenation` (iOS 15+) |
| [Measure](../../references/typography/index.md#cap-the-measure) | `.frame(maxWidth: 640)` on the text column | `readableContentGuide` |
| [Selectable text](../../references/typography/index.md#keep-useful-text-selectable) | `.textSelection(.enabled)`; `Text` is not selectable by default | `UITextView` with `isSelectable = true`, `isEditable = false` |
| [Language and bidi](../../references/typography/index.md#language-and-bidi-behavior) | `\.locale` and `\.layoutDirection` environment; `.typesettingLanguage(_:)` for script-correct line height | `semanticContentAttribute` |
| Isolate a mixed-direction value | Wrap it in U+2068 … U+2069 (first-strong isolate) | Same |

Raw tags through a descriptor:

```swift
let base = UIFont.preferredFont(forTextStyle: .body)
let descriptor = base.fontDescriptor.addingAttributes([
  .featureSettings: [[kCTFontOpenTypeFeatureTag: "ss01", kCTFontOpenTypeFeatureValue: 1]]
])
Text(code).font(Font(UIFont(descriptor: descriptor, size: 0) as CTFont))  // size 0 keeps the style's size
```

## Dynamic Type

- Every text style scales, and so must every custom font (`relativeTo:`) and every icon or spacing that sits in a line of text (`@ScaledMetric`). The text-size requirement itself is [accessibility](../../references/accessibility/index.md)'s.
- Restructure rather than truncate at accessibility sizes. Read `@Environment(\.dynamicTypeSize)` and switch on `.isAccessibilitySize` (an `HStack` row becomes a `VStack`), or let `ViewThatFits` choose.
- Cap growth only on chrome that cannot grow, such as a tab bar title: `.dynamicTypeSize(...DynamicTypeSize.accessibility2)`. Never cap content text; the HIG asks that content keep priority as text grows.
- `.minimumScaleFactor(_:)` and `.allowsTightening(true)` shrink a short single-line label to fit. Never on body text, which wraps instead.
- Bold Text reaches system fonts automatically. A custom face reads `@Environment(\.legibilityWeight)` and switches to its bolder cut when it is `.bold`.

## Fonts

- SF Pro is the system face on iOS, iPadOS, macOS, tvOS and visionOS; SF Compact on watchOS. Reach New York with `.fontDesign(.serif)`, SF Mono with `.monospaced`, the rounded variants with `.rounded`. Never bundle the system fonts.
- SF and New York size optically on their own, so there is no `Text` or `Display` cut to pick.
- A custom face ships every weight the design uses as `.otf` or `.ttf` in the bundle, registered under `UIAppFonts` (Fonts provided by application) in `Info.plist`.

## Before you finish

| Pattern | Fix |
| --- | --- |
| `.font(.system(size:))` or `.custom(_:fixedSize:)` on content text | A text style, or `.custom(_:size:relativeTo:)` |
| `.tracking` or `.kerning` on SF text | Remove it; SF tracks per size |
| `.lineSpacing(1.5)` read as a multiplier | `.lineHeight(.multiple(factor: 1.5))`, or the extra points it actually needs |
| A timer, counter or price without `.monospacedDigit()` | Add it |
| `.minimumScaleFactor` on multi-line or body text | Let it wrap |
| `.dynamicTypeSize(...)` cap on content | Remove it; restructure the layout at accessibility sizes |
| A fixed `.frame(height:)` around text | A minimum height, or none |
| An order number, address or error message without `.textSelection(.enabled)` | Add it |
| Copy stored in capitals for display | Store natural case and set `.textCase(.uppercase)` |
