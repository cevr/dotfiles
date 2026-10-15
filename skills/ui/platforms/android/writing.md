# Writing on Android

String resources, `plurals`, ICU formatters, and Material's writing conventions for the rules in [writing](../../references/writing/index.md) and [copy patterns](../../references/writing/patterns.md).

## String Resources

Every user-facing string lives in `res/values/strings.xml`, with translations in `res/values-<locale>/strings.xml`. Placeholders are positional, so a translator can reorder them:

```xml
<string name="invite_sent">%1$s invited you to %2$s</string>
```

| Need | API |
| --- | --- |
| A string in a composable | `stringResource(R.string.invite_sent, name, project)` |
| A string outside composition | `context.getString(R.string.invite_sent, name, project)` |
| Text that must not be translated inside a string | Wrap it in `<xliff:g id="…" example="…">`; the `xmlns:xliff` namespace goes on `<resources>` |

## Plurals

A `<plurals>` resource holds one item per [category](../../references/writing/patterns.md#plurals-and-placeholders). Always supply `one` and `other`, and keep `%d` in `one`, since `one` doesn't mean exactly 1 in every language:

```xml
<plurals name="inbox_count">
    <item quantity="one">%d new message</item>
    <item quantity="other">%d new messages</item>
</plurals>
```

```kotlin
Text(pluralStringResource(R.plurals.inbox_count, count, count))
```

Pass the count twice: the first selects the category, the second fills `%d`. Outside composition, `resources.getQuantityString(R.plurals.inbox_count, count, count)`.

Android selects by grammar only, so English never uses `quantity="zero"`. The exact-zero message is a separate `<string>` chosen in code:

```kotlin
Text(if (count == 0) stringResource(R.string.inbox_empty)
     else pluralStringResource(R.plurals.inbox_count, count, count))
```

## Locale Formatting

Take the locale from `LocalConfiguration.current.locales[0]` in Compose. Outputs match the [neutral table](../../references/writing/patterns.md#locale-formatting):

| Value | Call |
| --- | --- |
| Currency | `android.icu.text.NumberFormat.getCurrencyInstance(locale).apply { currency = Currency.getInstance("EUR") }.format(amount)` (API 24) |
| Unit | `MeasureFormat.getInstance(locale, MeasureFormat.FormatWidth.SHORT).format(Measure(12, MeasureUnit.MEGABYTE))` (API 24) |
| Date | `DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale).format(date)` (`java.time`, API 26 or desugaring) |
| Relative time | `RelativeDateTimeFormatter.getInstance(locale).format(Direction.LAST, AbsoluteUnit.DAY)` (API 24), or `DateUtils.getRelativeTimeSpanString` |
| List | `ListFormatter.getInstance(locale).format(names)` (API 26) |

`Currency`, `Measure`, `MeasureUnit`, `RelativeDateTimeFormatter`, and `ListFormatter` are the `android.icu` classes.

## Material Conventions

| Element | Material 3 convention |
| --- | --- |
| Buttons and UI text | Sentence case, capitalizing only the first word and proper nouns, which matches the neutral default |
| Button labels | One to three words, fully visible on a single line |

## Undo

`snackbarHostState.showSnackbar(message, actionLabel = "Undo")` shows an undo snackbar. With an `actionLabel`, `duration` defaults to `SnackbarDuration.Indefinite`, which satisfies the [timed UI rules](../../references/accessibility/motion-and-zoom.md#autoplay-and-timed-ui); check `SnackbarResult.ActionPerformed` to revert.

## Detection Patterns

The code behind the [neutral checklist](../../references/writing/index.md#before-you-finish):

| Grep for | Fix |
| --- | --- |
| `Text("…")` with a literal shown to people | A string resource |
| `"$count items"`, or `if (count == 1)` choosing a suffix | `pluralStringResource` |
| `quantity="zero"` expected to fire in English | A separate string for zero, chosen in code |
| `%s` and `%d` without positions in a string with two or more arguments | `%1$s`, `%2$d` |
| `SimpleDateFormat("MM/dd/yyyy")` or a hand-built date | `DateTimeFormatter.ofLocalizedDate` |
| `joinToString(", ")` on names shown to people | `ListFormatter` |
| `contentDescription = "Trash"`, `"Close icon"`, `"X"` | Name the action: `"Delete project"` |
