# Removed signals

What to look for on the `-` side of a hunk and which reference owns the judgement. **Owner** links the rule; the link beside a platform's signals goes to that platform's implementation.

| What a removal can mean | Web | Apple | Android | Owner |
| --- | --- | --- | --- | --- |
| The control or region lost its accessible name, description or announcement | `aria-label`, `aria-labelledby`, `aria-describedby`, `aria-live`, `role=` ([web](../../platforms/web/semantics-and-aria.md#accessible-names)) | `.accessibilityLabel`, `.accessibilityHint`, `.accessibilityValue`, `.accessibilityAddTraits`, `UIAccessibility.post` ([Apple](../../platforms/apple/accessibility.md#semantics)) | `contentDescription`, `stateDescription`, `semantics {`, `liveRegion`, `role =` ([Android](../../platforms/android/accessibility.md#semantics)) | [accessibility](../../references/accessibility/index.md) |
| Image, field or table cell lost its programmatic association | `alt=`, `<label`, `for=`, `htmlFor`, `scope=` ([web](../../platforms/web/accessibility.md#labels)) | A label on `Image`, the title of a `TextField` or `LabeledContent`, `.accessibilityElement(children: .combine)` ([Apple](../../platforms/apple/accessibility.md#forms)) | `contentDescription` on `Image` or `Icon`, `label =` on a text field, `semantics(mergeDescendants = true)` ([Android](../../platforms/android/accessibility.md#forms)) | [accessibility](../../references/accessibility/index.md) |
| Keyboard and assistive-technology behavior was traded for styling | `<button>`, `<a>`, `<nav>`, `<main>`, `<ul>` replaced by `div` or `span` ([web](../../platforms/web/semantics-and-aria.md#button-vs-link-vs-div)) | `Button`, `Link`, `Toggle`, `NavigationLink` replaced by `.onTapGesture` on a view ([Apple](../../platforms/apple/accessibility.md#semantics)) | `Button`, `IconButton`, `clickable`, `toggleable` replaced by `pointerInput` tap detection ([Android](../../platforms/android/accessibility.md#semantics)) | [accessibility](../../references/accessibility/index.md) |
| Keyboard users lost the focus indicator or the element left the focus order | `:focus-visible`, `:focus`, `outline`, `tabindex` ([web](../../platforms/web/accessibility.md#focus-rings)) | `.focusable`, `.focused`, `@FocusState` ([Apple](../../platforms/apple/accessibility.md#focus-and-keyboard)) | `focusable`, `FocusRequester`, `indication` ([Android](../../platforms/android/accessibility.md#focus-and-keyboard)) | [accessibility](../../references/accessibility/index.md) |
| Motion now ignores the user's system preference | `prefers-reduced-motion` ([web](../../platforms/web/accessibility.md#prefers-reduced-motion)) | `accessibilityReduceMotion`, `isReduceMotionEnabled` ([Apple](../../platforms/apple/accessibility.md#motion-and-zoom)) | `ANIMATOR_DURATION_SCALE` ([Android](../../platforms/android/accessibility.md#motion-and-zoom)) | [accessibility](../../references/accessibility/index.md) |
| Colors now ignore the user's contrast preference | `prefers-contrast` | `colorSchemeContrast`, a High Contrast appearance in a color set | — | [color](../../references/color/index.md) |
| Direction-aware layout was dropped | Logical properties swapped for `left` / `right` | `.natural` alignment or `leadingAnchor` swapped for `.left` / `leftAnchor` (UIKit); `.flipsForRightToLeftLayoutDirection` | `start` / `end` swapped for `left` / `right` (`absolutePadding`, `Alignment.Left`); `Icons.AutoMirrored` | [layout](../../references/layout/index.md) |
| Language metadata or text direction was dropped | `lang=`, `dir=` | `.typesettingLanguage`, `.environment(\.layoutDirection` | `localeList` in a `TextStyle` or `SpanStyle`, `LocalLayoutDirection` | [typography](../../references/typography/index.md) |
| Text rendering, wrapping or numeral alignment silently changed | `text-wrap`, `line-clamp`, `overflow-wrap`, `tabular-nums`, `font-feature-settings` | `.lineLimit`, `.truncationMode`, `.monospacedDigit`, `.minimumScaleFactor` | `maxLines`, `overflow =`, `softWrap`, `fontFeatureSettings`, `lineBreak`, `hyphens` | [typography](../../references/typography/index.md) |
| Text no longer scales with the user's text size | `rem` or `em` swapped for `px` on type ([web](../../platforms/web/accessibility.md#zoom-and-reflow)) | A text style (`.font(.body)`, `relativeTo:`, `@ScaledMetric`) swapped for a fixed size ([Apple](../../platforms/apple/accessibility.md#motion-and-zoom)) | `sp` swapped for `dp` on type ([Android](../../platforms/android/accessibility.md#motion-and-zoom)) | [accessibility](../../references/accessibility/index.md) |
| The rendered contrast pair may now fail; measure it | A color token swapped for a literal, or a token swapped for a lighter one | The same, with an asset-catalog color or semantic color (`.secondary`, `Color(.label)`) | The same, with a `colorScheme` role or `R.color` resource | [color](../../references/color/index.md) |
| A label, error or empty state lost the information it carried | A user-facing string deleted or shortened | The same, in code or the String Catalog | The same, in code or `strings.xml` | [writing](../../references/writing/index.md) |

## Equivalent replacements

These clear the signal. Drop a removal one of them explains before routing anything:

- `aria-label` giving way to `aria-labelledby` pointing at visible text.
- An explicit `role` dropped because the element became the native equivalent, such as `role="button"` going when a `div` becomes a `<button>`.
- `outline` replaced by a `box-shadow` ring on the same `:focus-visible` selector.
- `tabindex="0"` dropped from an element that is now natively focusable.
- A color literal replaced by a token with the same value.
- A physical property replaced by its logical counterpart, which is the fix rather than the regression.
- A string moved into the translation catalogue rather than deleted.
- An accessibility label dropped because the control now carries visible text the platform reads, such as an icon-only `Button` becoming `Button("Close", systemImage: "xmark")` or an `IconButton` becoming a text button.
- A tap gesture or `pointerInput` handler replaced by a `Button` or `clickable` with a role.

## Searching the removed side

Restrict the search to deleted lines so additions do not mask a removal. Pass the exclusion pathspecs from [Excluded paths](scope-resolution.md#excluded-paths) after `--`:

```bash
# Web
P='aria-|role=|alt=|htmlFor|for=|scope=|focus|outline|tabindex|prefers-|lang=|dir=|text-wrap|line-clamp|overflow-wrap|tabular-nums|font-feature|inset-|-inline|-block'
# Apple
P='accessibility|Button\(|Link\(|Toggle\(|focus|Focus|leading|natural|flipsForRightToLeft|typesettingLanguage|layoutDirection|lineLimit|truncationMode|monospacedDigit|minimumScaleFactor|\.font\(|relativeTo|ScaledMetric|colorSchemeContrast|ReduceMotion'
# Android
P='contentDescription|semantics|stateDescription|liveRegion|Role\.|clickable|toggleable|focus|Focus|indication|start =|end =|\.Start|\.End|AutoMirrored|localeList|LayoutDirection|maxLines|overflow =|softWrap|fontFeatureSettings|lineBreak|hyphens|\.sp\b|ANIMATOR_DURATION_SCALE'

git diff -U0 "$BASE" <head-ref> -- . <exclusions> \
  | grep -E '^-' | grep -vE '^--- (a/|/dev/null)' \
  | grep -E "$P"
```

Set `P` to the pattern for each platform the change touches, and run once per pattern in a multi-platform repository.

Leave `<head-ref>` off for a target that includes uncommitted work, so the diff runs against the working tree. Removed strings and swapped color tokens have no pattern; read those hunks.

Read the surrounding hunk before deciding. A removed attribute is meaningless without the element it came from, and `-U0` deliberately hides that context.
