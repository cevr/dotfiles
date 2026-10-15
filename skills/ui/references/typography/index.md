# Typography

Set and review how text renders, from the type scale and spacing to fonts, wrapping and punctuation. Write every fix in the project's styling system.

The words belong to [writing](../writing/index.md), semantic heading structure to [accessibility](../accessibility/index.md#structure-is-navigation) and spatial RTL layout to [layout](../layout/grouping-and-alignment.md#leading-and-trailing-for-anything-that-mirrors). Measure contrast with [color](../color/contrast.md); whether it passes is [accessibility](../accessibility/index.md)'s.

Implementation: [web](../../platforms/web/typography.md) · [Apple](../../platforms/apple/typography.md) · [Android](../../platforms/android/typography.md)

## Measured, not preferred

Some values here are exact. Line-height as a ratio of the size, weight `400` or heavier below `18pt`, a 60–75 character measure, text sized in the unit that follows the user's text-size setting and tabular figures on changing values are findings when missed.

Letter-spacing, pairing and scale ratios are heuristics. Report them only where they break the project's own scale. Never propose a new typeface, paid or free, unless the task asks for a type change.

Apple's Dynamic Type text styles and the Material 3 type scale are platform scales: where a project uses them, their sizes, leading and tracking replace the values below ([Apple](../../platforms/apple/typography.md#the-system-scale-wins), [Android](../../platforms/android/typography.md#the-material-scale-wins)).

## Fewer fonts, sizes and weights

Rarely use more than three fonts; marketing pages can carry more than apps. Weight and size carry hierarchy, so each extra one dilutes it. Pair for contrast. A serif headline over a sans body reads as deliberate, two near-identical sans-serifs read as a mistake.

Below `18pt`, use weight `400` or heavier. Weights `100`–`300` belong at `28pt` and up, checked against the background even there. Categories, `Display` and `Text` cuts and fallbacks are in [choosing-fonts.md](choosing-fonts.md).

## Ship the faces the design uses

A text renderer synthesizes a weight or style the family doesn't ship, smearing a bold or slanting a roman, and the face distorts. Ship every face the design uses. Disable synthesis only after verifying the fallback fonts, and only the unwanted mode. **Web:** the `@font-face` files and the [synthesis longhands](../../platforms/web/typography.md#fonts-and-synthesis).

## Named settings over raw tags

When the platform has a named setting for an axis or feature, use it rather than the raw tag: weight `650` through the weight setting, not the `wght` axis; tabular figures through the numeric setting, not `tnum`. Named settings keep working when a non-variable fallback renders.

Leave optical sizing automatic. Hard-code `opsz` only when the design deliberately decouples optical size from text size. Reserve raw tags for custom axes like `GRAD 80` and features with no named setting, like `ss01`. Axes, features and variable versus static files are in [variable-fonts-and-opentype.md](variable-fonts-and-opentype.md).

## Use a type scale with semantic names

Define a small set of sizes and deviate from it as little as possible. Pair each size with its line-height and weight, so a role is one decision instead of three.

Solo, generic names like `text-sm` are fine when the usage rules are clear. On a team, name sizes by use (`body-sm`) so the rules survive other people. A [role-based starting scale](spacing-and-sizing.md#type-scale) is in the reference.

## Heading sizes descend with level

Map heading levels to descending steps of the scale, so a subordinate heading never overpowers its parent. Deep levels may share a size where the scale runs out of steps, as long as weight or letter-spacing keeps them distinct. A heading is never smaller than body text unless it is a deliberate overline. See the [level mapping](spacing-and-sizing.md#heading-hierarchy).

## Line-height by role

Display text `1.1`, headings `1.2`–`1.3`, body copy `1.5`–`1.6`. Express line-height as a ratio of the text size so it scales with the text; a fixed height stays put while the text grows. **Web:** unitless `line-height`.

Tight line-height is for short text. Anything that wraps to three or more lines needs at least `1.4`, even in a height-constrained row. See the [card description example](spacing-and-sizing.md#line-height-for-wrapping-text).

## Letter-spacing by size

Headings at `24pt` and up take `-0.01em` to `-0.02em`. Uppercase labels at `14pt` or smaller take `0.05em`. Body copy stays at `0`. Express tracking relative to the size (`1em` is the text size) so it scales with it.

Kerning is built into the font and on by default. Turning it off is never a fix.

## Cap the measure

Cap long-form text at 60–75 characters per line. Any unit works, as long as a cap exists and the line length lands in range. See the [point equivalents](wrapping-and-punctuation.md#measure-line-length).

## Wrap deliberately

- Balance the lines of headings and short descriptions; never balance paragraphs. **Web:** `text-wrap: balance`, which Chromium ignores past six lines.
- Keep a lone word off a paragraph's last line. Safe on any paragraph, long-form included. **Web:** `text-wrap: pretty`.
- Let a long word, link or ID break where it would otherwise escape its container. **Web:** `overflow-wrap: break-word`.
- Keep labels and badges on one line where a break looks broken. **Web:** `white-space: nowrap`.

Keep interface text start-aligned. Justified text belongs only in specific editorial layouts.

## Tabular numbers on changing values

Apply tabular figures to timers, counters, prices and numeric table columns, so every digit keeps one width and nothing shifts. Leave figures in prose proportional. **Web:** `font-variant-numeric: tabular-nums`.

## Truncate with a way back

Truncate a single line with a trailing ellipsis; clamp longer text to a set number of lines, ellipsis on the last. **Web:** Tailwind's `truncate` and `line-clamp-3`; the raw declarations are in the [cheat sheet](../../platforms/web/typography-css.md#wrapping-and-overflow).

A truncated value needs a way back to the full text, which [layout](../layout/spacing-and-adaptivity.md#hint-at-hidden-content) owns.

## Natural case, typographic punctuation

Store text in natural case and set case in the style layer, so a redesign never means rewriting copy. **Web:** `text-transform`.

Rendered text uses typographic characters, never their keyboard stand-ins. Curly quotes, en dashes, the ellipsis character and non-breaking spaces are in the [substitution table](wrapping-and-punctuation.md#smart-punctuation). Code keeps straight quotes.

## Underlines from the font

Take underline position and thickness from the font's metrics, or tune offset and thickness by hand. A dotted underline hints that a word carries extra information, such as an abbreviation or a defined term. **Web:** the [underline recipes](../../platforms/web/typography.md#underlines).

Color is the only part of a real underline that animates reliably. Any other underline animation needs a separate element, and its motion belongs to [motion](../motion/index.md).

## Size floors

Start long-form body text at `16pt`. Move off it only for a reason you can name, such as a typeface that runs small, a narrow measure or a dense professional tool. Platform scales set their own body size (Apple `17pt`, Material `16sp`).

UI text can go smaller. Start inputs and menus at `14pt` and captions at `13pt`, and rarely go below `12pt`. Size text in the platform's scalable unit so the user's text-size setting still applies: `rem` on the web, Dynamic Type on Apple, `sp` on Android. **Web:** input text below `16px` makes iOS Safari zoom the page; the fixes are in [iOS input zoom](../../platforms/web/typography.md#ios-input-zoom).

## Language and bidi behavior

Mark each text's language so the renderer and assistive technology pick the right quotes, hyphenation, line breaking and pronunciation. Mark the direction at the root and wherever it changes. Isolate a mixed-direction value, such as a name, number or URL inside text of the other direction, and never reorder digits by hand. How long paragraphs and numbers behave is in [wrapping-and-punctuation.md](wrapping-and-punctuation.md#internationalization). **Web:** `lang`, `dir` and `<bdi>`.

## Trim text boxes in tight containers

In buttons and badges, the space a font reserves above and below its letters makes text sit low. Trim the line box to the cap height and baseline where the platform can, as a progressive enhancement. **Web:** [`text-box`](../../platforms/web/typography.md#text-trimming-with-text-box).

## Decorative text as live text

Build drop caps, gradient text, outlines and text shadows as styled text, not images, so the text stays selectable, searchable, scalable and readable by assistive technology. **Web:** the [properties and their support](../../platforms/web/typography.md#decorative-text).

## Keep useful text selectable

Text the user may need to copy, such as addresses, error messages and order numbers, stays selectable. That is the web default; native text needs selection enabled. A selection highlight may carry brand, as long as the selected combination stays legible.

Suppress selection only on a drag or gesture surface where accidental selection interferes, and on touch controls where a long-press would select the label instead of pressing it. Never across the interface, and never on content text. **Web:** [selection styling](../../platforms/web/typography.md#selection).

## Emphasis and headings

- Bold or italic, never both. In sans-serif interface text, emphasize with weight; sans italic is too subtle to read as emphasis. Emphasize phrases, never whole paragraphs.
- Headings are bold, not italic, never underlined, and never hyphenated. Keep a view to two or three visual heading levels.
- Weight never changes on hover or selection; the wider glyphs shift layout. Signal state with color, or reserve the bold width ahead of time.

## Paragraph rhythm

Separate paragraphs with spacing at 50–100% of the body size, not empty lines. Use spacing or a first-line indent, never both; an indent is 1–4× the body size, never spaces. One space after punctuation. **Web:** `margin` and `text-indent`.

## Reference files

| File | Read when |
| --- | --- |
| [choosing-fonts.md](choosing-fonts.md) | Picking a typeface category or `Display`/`Text` cut, routing a requested type change, or explaining why two fonts at one size look different |
| [spacing-and-sizing.md](spacing-and-sizing.md) | Setting up a type scale, mapping heading levels or fixing leading on wrapping text |
| [variable-fonts-and-opentype.md](variable-fonts-and-opentype.md) | Static versus variable files, variable axes, OpenType features, small caps, super and subscripts, stylistic sets |
| [wrapping-and-punctuation.md](wrapping-and-punctuation.md) | Capping the measure, substituting typographic punctuation, or handling mixed-direction paragraphs and digits |

## Before you finish

Each platform file adds the API-level patterns for these.

| Pattern | Fix |
| --- | --- |
| A weight the shipped font files don't include | Ship that face or use a weight the family ships |
| A raw axis or feature tag where a named setting exists | The named setting |
| Line-height fixed in points while the text size scales | A ratio of the size |
| Line-height under `1.4` on a description, card body or anything that can wrap | `1.4` or more |
| Letter-spacing fixed in points on text that scales | The same value relative to the size |
| Text sized in fixed units that ignore the user's text-size setting | The platform's scalable unit |
| Weight `100`–`300` on text under `18pt` | `400` or heavier |
| Balanced wrapping on a paragraph | Last-line orphan avoidance instead |
| Justified text in application UI | Start alignment |
| A timer, counter, price or numeric column with proportional figures | Tabular figures |
| `...`, `--` or a hyphenated range in rendered strings | `…`, an em dash or an en dash |
| Mixed-direction value such as a name, number or URL with no isolation | Isolate it |
| Selection disabled on a layout root or content text | Re-enable it; keep it off only on a drag or gesture surface |

## Reporting

**Severity.** `HIGH` makes text unreadable, truncates content with no way back to it or clips text at `320pt` width or at 200% text size (the largest text size on native). The last two are escalation triggers of the [cross-discipline review](../../workflows/review.md), so they stay `HIGH` however minor the surface. `MEDIUM` breaks the type system or the visual heading hierarchy. `LOW` is isolated polish.

**Verification.** Without a render, check declared size and weight per heading level, descending within each semantic section. Check declared line-height, units and measure. Check truncation rules against realistic string lengths. With one (a browser, a preview, a simulator or emulator), compare rendered values, then resize the viewport and raise the text size with real content to catch wrapping, lone last-line words and truncation. Report every check you could not run as `Not verified`.

**Format.** Group findings under the principle each violates, ordered by severity, one row per root cause listing every location it appears in:

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |

`Location` is `path/to/file:line`. `Why` names the principle and the user impact.

End with `Block` when any `HIGH` remains, `Approve` otherwise, leaving the rest in the table as work to do. Never `Approve` coverage you did not inspect. With nothing to report, state "No actionable typography findings" and report verification.
