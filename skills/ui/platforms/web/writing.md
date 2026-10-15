# Writing on the Web

ICU messages and `Intl` for the rules in [writing](../../references/writing/index.md) and [copy patterns](../../references/writing/patterns.md).

## Plurals and Placeholders

Most i18n libraries (FormatJS / `react-intl`, `i18next` with its ICU plugin, `next-intl`) read ICU MessageFormat. One message per sentence, with the [plural categories](../../references/writing/patterns.md#plurals-and-placeholders) as branches:

```text
inbox.count = {count, plural,
  =0 {No new messages}
  one {# new message}
  other {# new messages}
}
invite.sent = {name} invited you to {project}
```

`=0` matches the number zero exactly; `one` and `other` are categories, and `#` prints the count in the locale's digits. Without a library, pick the category with `new Intl.PluralRules(locale).select(count)`.

## Locale Formatting

Pass the user's locale (from `Accept-Language` on the server, `navigator.languages` on the client, or the i18n library's active locale) to `Intl`. Outputs are the [neutral table's](../../references/writing/patterns.md#locale-formatting):

| Value | Call |
| --- | --- |
| Currency | `new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" })` |
| Unit | `new Intl.NumberFormat(locale, { style: "unit", unit: "megabyte" })` |
| Date | `new Intl.DateTimeFormat(locale, { dateStyle: "medium" })` |
| Relative time | `new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-1, "day")` |
| List | `new Intl.ListFormat(locale, { type: "conjunction" })` |

A server and client that format with different locales or time zones produce a hydration mismatch ([theming](theming.md#mode-edges)).

## Detection Patterns

The code behind the [neutral checklist](../../references/writing/index.md#before-you-finish):

| Grep for | Fix |
| --- | --- |
| `" + n + "`, a template literal holding a sentence fragment, or `=== 1 ? "" : "s"` | One ICU message with a plural argument |
| `>OK<`, `>Yes<` or `>No<` on a dialog button | Verb plus object |
| `aria-label="Trash"`, `"Close icon"` or `"X"` | Name the action: `aria-label="Delete project"` |
| `toLocaleDateString()` with no locale, or a date built from `getMonth()` | `Intl.DateTimeFormat` with the user's locale |
| `.join(", ")` on names shown to people | `Intl.ListFormat` |
