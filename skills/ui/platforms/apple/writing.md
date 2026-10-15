# Writing on Apple Platforms

String Catalogs, `String(localized:)`, `FormatStyle`, and the HIG's writing conventions for the rules in [writing](../../references/writing/index.md) and [copy patterns](../../references/writing/patterns.md). The HIG's writing guidance matches the neutral rules; the conventions below are where Apple sets its own value, and they win on Apple platforms.

## Localized Strings

| Need | API |
| --- | --- |
| A label in a view | `Text("Save draft")`, `Button("Delete Project") { … }`: a string literal is a `LocalizedStringKey`, localized and extracted into the String Catalog (`Localizable.xcstrings`) on build |
| A string outside a view | `String(localized: "Changes saved", comment: "Status after saving the editor")` |
| A string passed into a custom view | Type the parameter `LocalizedStringKey` or `LocalizedStringResource`; a plain `String` variable passed to `Text` is shown verbatim, untranslated |
| Text that must never be translated | `Text(verbatim: sku)` |
| Wording that differs per device ("tap" vs "click") | The String Catalog's Vary by Device |

Every string gets a `comment:` for translators when the key alone is ambiguous. Interpolation (`Text("\(name) invited you to \(project)")`) is one message with placeholders; the translator can reorder them.

## Plurals

Interpolate the count into a localizable string, `Text("\(count) new messages")`, build, then choose Vary by Plural on that key in the String Catalog. Xcode adds the categories each language needs: One and Other for English, One, Few, Many, and Other for Russian ([categories](../../references/writing/patterns.md#plurals-and-placeholders)). Projects without String Catalogs carry the same variants in a `.stringsdict` file.

The exact-zero message is its own string, chosen in code:

```swift
if count == 0 { Text("No new messages") } else { Text("\(count) new messages") }
```

## Locale Formatting

`FormatStyle` uses the current locale; inside a view, read `@Environment(\.locale)` and pass `.locale(locale)` so previews and per-view overrides apply. Outputs match the [neutral table](../../references/writing/patterns.md#locale-formatting):

| Value | Call |
| --- | --- |
| Currency | `amount.formatted(.currency(code: "EUR"))` |
| Unit | `Int64(bytes).formatted(.byteCount(style: .file))`; other units through `Measurement(…).formatted(.measurement(width: .abbreviated))` |
| Date | `date.formatted(date: .abbreviated, time: .omitted)` |
| Relative time | `date.formatted(.relative(presentation: .named))` |
| List | `names.formatted(.list(type: .and))` |

In SwiftUI, `Text(amount, format: .currency(code: "EUR"))` formats in place, and `Text(date, style: .relative)` keeps updating.

## HIG Conventions

| Element | Apple convention |
| --- | --- |
| Button titles, menu items | Title-style capitalization ("Add to Cart", "View All"), no ending punctuation. This replaces the neutral sentence-case default for these elements |
| Alert title | Describes the situation, never just "Error". A fragment takes title-style capitalization and no period; a full sentence takes sentence case and punctuation. At most two lines |
| Alert message | Only when it adds value; complete sentences, sentence case |
| Alert buttons | One or two words describing the result ("Erase", "Reply"). "OK" only in a purely informational alert. The cancel button is always titled "Cancel" |
| Destructive role | `role: .destructive` on a button whose destructive action the person didn't deliberately choose; never make a destructive button the default |
| Ellipsis | On a button or menu item that opens another view or needs more input before acting ("Rename…") |
| Device verbs | "Tap" on iPhone and iPad touch, "click" on Mac |

## Undo

There is no system toast. Register reversible actions with the `UndoManager` (`@Environment(\.undoManager)`), which gives Mac users Edit > Undo and iPhone users shake to undo, and show an in-app undo banner that follows the [timed UI rules](../../references/accessibility/motion-and-zoom.md#autoplay-and-timed-ui).

## Detection Patterns

The code behind the [neutral checklist](../../references/writing/index.md#before-you-finish):

| Grep for | Fix |
| --- | --- |
| `Text(someString)` with a `String` variable, or a custom view taking `title: String` | `LocalizedStringKey` / `LocalizedStringResource` parameter |
| `+ (count == 1 ? "" : "s")`, or `"\(count) item"` plus a suffix | One interpolated string with Vary by Plural |
| `NSLocalizedString("…", comment: "")` | `String(localized:comment:)` with a real comment |
| `DateFormatter` with a fixed `dateFormat`, or `NumberFormatter` with a hardcoded symbol | `FormatStyle` (`.formatted(…)`) |
| `.joined(separator: ", ")` on names shown to people | `.formatted(.list(type: .and))` |
| `.accessibilityLabel("Trash")`, `"Close icon"`, `"X"` | Name the action: `.accessibilityLabel("Delete Project")` |
| `Button("OK")` or `Button("Yes")` in a confirmation | Verb plus object, plus a `Cancel` button |
