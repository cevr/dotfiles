# Typography on Android

How the [typography](../../references/typography/index.md) rules are built in Jetpack Compose with Material 3. The rules and their reasons live there; this file maps each to an API and states where Material's own values win.

## The Material scale wins

Use `MaterialTheme.typography`, not the neutral [type scale](../../references/typography/spacing-and-sizing.md#type-scale). Each style carries size, line height, weight and tracking. The defaults (`TypeScaleTokens` in `androidx.compose.material3`):

| Role | Style | Size / line height (sp) | Weight | Tracking (sp) |
| --- | --- | --- | --- | --- |
| Display | `displayLarge` | 57 / 64 | 400 | -0.2 |
| | `displayMedium` | 45 / 52 | 400 | 0 |
| | `displaySmall` | 36 / 44 | 400 | 0 |
| Title | `headlineLarge` | 32 / 40 | 400 | 0 |
| | `headlineMedium` | 28 / 36 | 400 | 0 |
| | `headlineSmall` | 24 / 32 | 400 | 0 |
| Heading | `titleLarge` | 22 / 28 | 400 | 0 |
| | `titleMedium` | 16 / 24 | 500 | 0.2 |
| | `titleSmall` | 14 / 20 | 500 | 0.1 |
| Body | `bodyLarge` | 16 / 24 | 400 | 0.5 |
| | `bodyMedium` | 14 / 20 | 400 | 0.2 |
| | `bodySmall` | 12 / 16 | 400 | 0.4 |
| Label | `labelLarge` | 14 / 20 | 500 | 0.1 |
| | `labelMedium` | 12 / 16 | 500 | 0.5 |
| | `labelSmall` | 11 / 16 | 500 | 0.5 |

Material's positive body tracking and its weight-`400` headings replace the neutral [letter-spacing](../../references/typography/index.md#letter-spacing-by-size) and scale weights in a Material project. Labels (buttons, chips, tabs) use the `label*` styles. Recent material3 releases add an emphasized twin of each style (`bodyLargeEmphasized`, `titleMediumEmphasized`, …) one weight step up, which is the neutral rule for emphasis within a role.

Customize by passing styles to `Typography(...)`. M3's `Typography` has no default family parameter, so set `fontFamily` on every style you override:

```kotlin
val AppTypography = Typography(
    bodyLarge = TextStyle(fontFamily = Satoshi, fontWeight = FontWeight.Normal,
        fontSize = 16.sp, lineHeight = 24.sp, letterSpacing = 0.5.sp),
    titleLarge = TextStyle(fontFamily = Satoshi, fontWeight = FontWeight.SemiBold,
        fontSize = 22.sp, lineHeight = 28.sp),
)
MaterialTheme(typography = AppTypography) { /* … */ }
```

## Rule to API

| Rule | Compose |
| --- | --- |
| [Type scale](../../references/typography/index.md#use-a-type-scale-with-semantic-names) | `style = MaterialTheme.typography.bodyLarge`; a one-off override with `.copy(...)`, never a literal `TextStyle` |
| [Scalable unit](../../references/typography/index.md#size-floors) | `fontSize` in `sp`; everything else in `dp` |
| [Line-height by role](../../references/typography/index.md#line-height-by-role) | `lineHeight = 1.5.em` (a ratio) or in `sp`; never `dp`, which does not scale |
| [Letter-spacing](../../references/typography/index.md#letter-spacing-by-size) | `letterSpacing = (-0.02).em`; Material's own tokens use `sp` |
| [Tabular numbers](../../references/typography/index.md#tabular-numbers-on-changing-values) | `fontFeatureSettings = "tnum"`. Compose has no named setting, so the raw tag is the API |
| Small caps, super and subscript | `fontFeatureSettings = "smcp"` / `"sups"`; `baselineShift = BaselineShift.Superscript` with a smaller size when the font lacks the glyphs |
| Stylistic sets | `fontFeatureSettings = "ss01"` |
| Variable axes | `Font(R.font.flex, variationSettings = FontVariation.Settings(FontVariation.weight(650), FontVariation.Setting("GRAD", 80f)))`, applied on API 26+; prefer `FontVariation.weight` over the raw `wght` setting |
| [Synthesis](../../references/typography/index.md#ship-the-faces-the-design-uses) | `fontSynthesis = FontSynthesis.None` (or `.Weight`, `.Style`) on the isolated treatment only |
| [Truncate](../../references/typography/index.md#truncate-with-a-way-back) | `maxLines = 1, overflow = TextOverflow.Ellipsis`; `TextOverflow.MiddleEllipsis` for file names and IDs |
| Shrink a short label to fit | `autoSize = TextAutoSize.StepBased(minFontSize = 12.sp)`; never on body text, which wraps |
| [Wrap deliberately](../../references/typography/index.md#wrap-deliberately) | `lineBreak = LineBreak.Heading` on titles, `LineBreak.Paragraph` on body; `LineBreak.Paragraph.copy(strategy = LineBreak.Strategy.Balanced)` to balance; `softWrap = false` keeps a label on one line |
| Hyphenation | `hyphens = Hyphens.Auto`; off by default, and it needs the text's locale |
| Start alignment | `textAlign = TextAlign.Start`, never `Left`, which ignores RTL |
| [Natural case](../../references/typography/index.md#natural-case-typographic-punctuation) | No style-level case; uppercase at render with `text.uppercase(Locale.getDefault())` |
| [Underlines](../../references/typography/index.md#underlines-from-the-font) | `textDecoration = TextDecoration.Underline`; position, thickness and dotted style are not exposed, so a custom one draws with `Modifier.drawBehind` |
| [Measure](../../references/typography/index.md#cap-the-measure) | `Modifier.widthIn(max = 640.dp)` on the text column |
| [Selectable text](../../references/typography/index.md#keep-useful-text-selectable) | `SelectionContainer { Text(orderNumber) }`; `Text` is not selectable by default |
| [Language and bidi](../../references/typography/index.md#language-and-bidi-behavior) | `localeList = LocaleList("ar")`, `textDirection = TextDirection.Content`; `BidiFormatter.getInstance().unicodeWrap(value)` isolates a mixed-direction value |
| [Trim text boxes](../../references/typography/index.md#trim-text-boxes-in-tight-containers) | `lineHeightStyle = LineHeightStyle(alignment = LineHeightStyle.Alignment.Center, trim = LineHeightStyle.Trim.Both)`; works only with `includeFontPadding = false`, the default since Compose BOM `2024.01.01` |

## Font scaling

- Android 14 scales text up to 200% on a nonlinear curve: large text grows less than small text. `sp` gets this automatically; `dp` text does not scale at all.
- Give `lineHeight` in `sp` or `em` too, or the lines stay put while the text grows.
- Never size padding or containers in `sp`. Under nonlinear scaling `4.sp + 20.sp` is not `24.sp`.
- Convert `sp` to pixels through `Density` (`with(LocalDensity.current) { 16.sp.toPx() }`) or `TypedValue.applyDimension`. Never multiply by `fontScale` yourself; it no longer describes the curve.
- Restructure rather than truncate at large scales: a row that runs out of width becomes a column. Preview with `@Preview(fontScale = 2f)` and check on a device at the largest system font size. The text-size requirement itself is [accessibility](../../references/accessibility/index.md)'s.

## Fonts

- The default `FontFamily.Default` is the device's system face, Roboto on most devices. It needs no files.
- A bundled face lives in `res/font/` and declares every weight and style the design uses: `FontFamily(Font(R.font.satoshi_regular), Font(R.font.satoshi_medium, FontWeight.Medium))`. A weight with no `Font` entry is synthesized.
- Downloadable Google Fonts come through `androidx.compose.ui:ui-text-google-fonts` with a `GoogleFont.Provider`; declare a bundled fallback for first launch offline.

## Before you finish

| Pattern | Fix |
| --- | --- |
| A literal `TextStyle(fontSize = …)` where a `MaterialTheme.typography` style fits | The style, with `.copy(...)` for a one-off |
| Text size or `lineHeight` in `dp`, or a `Dp` converted to text size | `sp`, or `em` for line height |
| `sp` on padding, icon size or container height | `dp` |
| `TextAlign.Left` or `TextAlign.Right` | `TextAlign.Start` or `TextAlign.End` |
| A timer, counter or price without `fontFeatureSettings = "tnum"` | Add it |
| `maxLines` with no `overflow`, or an ellipsis with no way back to the text | `TextOverflow.Ellipsis` and a route to the full value |
| A `FontFamily` missing a weight the design uses | Add that `Font` |
| A copyable value (order number, address, error) outside `SelectionContainer` | Wrap it |
| `autoSize` on body or multi-line text | Let it wrap |
