# Failure signatures

What **Look once** in [stress-test](../stress-test.md) sees on the harness, the cause that is almost always behind it and the fix on each platform. Write the fix in the project's own idiom; a cell marked — means the platform does not produce that break by default.

## Layout

| What you see | Cause | Web | Apple (SwiftUI) | Android (Compose) |
| --- | --- | --- | --- | --- |
| Avatar or icon squished into an oval or pill | A fixed-size box allowed to shrink | `flex-shrink: 0` on the avatar, icon and any fixed-size box | A fixed `.frame(width:height:)` on the image with `.scaledToFill()` and a clip shape | `Modifier.size(…)` on the image, and `Modifier.weight(1f)` on the text so it is what yields |
| Text overflows its box instead of wrapping or truncating | The text column refuses to shrink below its content | `min-width: 0` on the text column (`minmax(0, 1fr)` in grid) | Remove `.fixedSize()` from the text; give it a `lineLimit` where it should truncate | `Modifier.weight(1f)` on the text column in the `Row` |
| Trailing action (••• menu, button) pushed off-screen or clipped | Middle content took all the space | `min-width: 0` on the middle, `flex-shrink: 0` on the action | `.layoutPriority(1)` or `.fixedSize()` on the action | `Modifier.weight(1f)` on the middle; the action keeps its own size |
| Badge wraps onto two lines | Badge allowed to shrink | `white-space: nowrap; flex-shrink: 0` on the badge, and decide what yields instead | `.lineLimit(1)` and `.fixedSize()` on the badge, and decide what yields instead | `maxLines = 1, softWrap = false` on the badge text, and `weight(1f)` on what yields |
| Avatar centered against a three-line name looks adrift | Center alignment on rows of varying height | Top-align (`align-items: flex-start`) once text can wrap | `HStack(alignment: .top)`, or `.firstTextBaseline` | `Row(verticalAlignment = Alignment.Top)` |
| Last row cut off at a hard edge mid-glyph | Fixed-height container with no fade or scroll affordance | Visible scrollbar or a fade mask, and ensure `overflow` is intended | A `ScrollView` or `List` in place of a fixed `.frame(height:)` with `.clipped()` | `Modifier.verticalScroll` or a `LazyColumn` in place of a fixed `height` that clips |
| Long translated button label overflows | Fixed-width button | Width from content with `min-width`, never a fixed `width` | `.frame(minWidth:)`, never `.frame(width:)` | `Modifier.widthIn(min = …)`, never `Modifier.width` |
| Scrolling 1,000 rows stutters | Every row rendered | Virtualize, or paginate, and say which | `List` or `LazyVStack` in place of a `VStack` in a `ScrollView`, or paginate | `LazyColumn` in place of a `Column` with `verticalScroll`, or paginate |

## Text

| What you see | Cause | Web | Apple (SwiftUI) | Android (Compose) |
| --- | --- | --- | --- | --- |
| Email or URL runs past the edge | No break opportunity in the string, and line breaking turned off | `overflow-wrap: anywhere` on that element | Remove `.fixedSize()`; for one line, `.lineLimit(1)` with `.truncationMode(.middle)` | Remove `softWrap = false`; for one line, `maxLines = 1` with `TextOverflow.MiddleEllipsis` (single line only, it clips on more) |
| Long word breaks mid-word in a heading | `word-break: break-all` | `overflow-wrap: anywhere` breaks only when it has to | — | — |
| Diacritics or tall scripts (Vietnamese, Thai) clipped top or bottom | A tight line box that clips | Looser `line-height`, or no `overflow: hidden` on text boxes | Remove a fixed `.frame(height:)` and `.clipped()` from the text | Remove a fixed `Modifier.height` from the text; no `lineHeight` below the style's |
| Truncated text with no way to read it | Ellipsis and nothing else | `title` attribute or a tooltip, and the full value elsewhere (detail view) | `.help()` on macOS, a context menu or the full value in a detail view | A `TooltipBox`, or the full value in a detail view |
| Content renders raw `<b>`, `&amp;` or `**text**` | Wrong escaping layer | Escape once, at render; never `dangerouslySetInnerHTML` user data | User data through `Text(verbatim:)` or a `String` value; a literal or `LocalizedStringKey` parses Markdown | User data as a plain `String`; `AnnotatedString.fromHtml` only for markup you trust |

## Formatting

The rules live in [writing](../../references/writing/patterns.md) and [typography](../../references/typography/index.md); the APIs in each platform's writing and typography files.

| What you see | Cause | Fix |
| --- | --- | --- |
| Wrong initials (`"J"` for "Jo", `"CI"` for "… Montgomery III", `"�"` for an emoji-first name) | `.split(' ')[0][0]` style code | Initials from grapheme clusters, first + last word, fallback icon. **Web:** `Intl.Segmenter`. **Apple:** `PersonNameComponents` formatted with the `.abbreviated` style; a Swift `Character` is already a grapheme cluster. **Android:** `BreakIterator.getCharacterInstance()`; a Kotlin `Char` is half an emoji |
| "1 members", "0 member" | Hardcoded plural | The platform's plural rules, one message per sentence ([plurals](../../references/writing/patterns.md#plurals-and-placeholders); APIs: [web](../../platforms/web/writing.md#plurals-and-placeholders) · [Apple](../../platforms/apple/writing.md#plurals) · [Android](../../platforms/android/writing.md#plurals)). **Web:** `Intl.PluralRules` |
| Numbers jitter when they update, columns misalign | Proportional figures | Tabular figures ([rule](../../references/typography/index.md#tabular-numbers-on-changing-values); APIs: [web](../../platforms/web/typography.md) · [Apple](../../platforms/apple/typography.md) · [Android](../../platforms/android/typography.md)). **Web:** `font-variant-numeric: tabular-nums` |
| `1284`, `1,284.000000001`, `NaN`, `undefined`, `null` | Raw number rendered | The platform's number formatter with the user's locale, and a guard for null ([locale formatting](../../references/writing/patterns.md#locale-formatting); APIs: [web](../../platforms/web/writing.md#locale-formatting) · [Apple](../../platforms/apple/writing.md#locale-formatting) · [Android](../../platforms/android/writing.md#locale-formatting)). **Web:** `Intl.NumberFormat` |

## Content

These read the same on every platform; the fix is in what renders, not in an API.

| What you see | Cause | Fix |
| --- | --- | --- |
| Orphaned `—` or empty line where the role was | Placeholder rendered for a missing optional field | Omit the line, or reserve its height intentionally |
| Broken-image icon or blank circle in the avatar | No load-failure fallback | Fall back to initials, and cover-scale any aspect ratio: `onError` with `object-fit: cover` on the web; `AsyncImage`'s failure phase with `.scaledToFill()` on Apple; the image loader's error slot (Coil's `error`) with `ContentScale.Crop` on Android |
