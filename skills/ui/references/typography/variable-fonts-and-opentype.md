# Variable fonts and OpenType

What a font file can do beyond drawing letters. How to reach each ability per platform: [web](../../platforms/web/typography.md#properties-over-raw-tags) · [Apple](../../platforms/apple/typography.md#rule-to-api) · [Android](../../platforms/android/typography.md#rule-to-api).

## Static vs variable

- **Static font:** one weight and one style per file. Regular, medium and bold is three files.
- **Variable font:** a whole range in one file. Any value in it works, such as weight `589`.

A variable font is not automatically better. At one or two weights, static files can be smaller. At several weights, optical sizes or custom axes, a variable font usually wins.

## Axes

Variable-font controls, each with a four-letter tag. A font supports only the axes its designer included.

| Axis | Tag | Controls |
| --- | --- | --- |
| Weight | `wght` | Stroke thickness |
| Optical size | `opsz` | Details and spacing tuned for the display size |
| Width | `wdth` | Glyph width |
| Slant | `slnt` | Slant angle |
| Custom | e.g. `GRAD` (Roboto Flex) | Whatever the designer built |

Inter's variable file exposes only `wght` and `opsz`.

Optical sizes predate variable fonts. Many families still ship them as separate `Text` and `Display` files instead of an `opsz` axis.

## Named settings, raw tags for the rest

A raw axis or feature tag is silently ignored on a non-variable fallback face, where the named weight setting still picks the nearest face. Common axes (weight, width, slant, optical size) and common features (tabular figures, slashed zero, small caps, super and subscripts) have named settings on most platforms; use them. Custom axes such as `GRAD 80` and the numbered slots such as `ss01` have no named setting, so they take raw tags.

## OpenType features

Unlike axes, features work the same on static and variable fonts. A font ships only the features its designer included.

| Tag | Feature |
| --- | --- |
| `tnum` | Tabular numbers: every digit the same width |
| `zero` | Slashed zero: `0` distinct from `O` |
| `liga` | Ligatures: joins pairs like "fi" into one shape |
| `smcp` | Small capitals from lowercase |
| `sups` / `subs` | Superscript and subscript glyphs |
| `ss01`–`ss20` | Stylistic sets (numbered slots) |
| `cv01`–`cv99` | Character variants (numbered slots) |

## Small caps, superscripts, subscripts

- **Small capitals:** uppercase letters drawn at a smaller size. Use the font's real ones, never shrunken capitals.
- **Superscripts** sit above the normal line, the 2 in x², and **subscripts** below it, as in H₂O. Use the font's proper glyphs rather than shrinking and shifting regular digits where the platform can reach them.

Both require the font to include the glyphs.

## Stylistic sets and character variants

`ss01` = stylistic set, slot 01. `cv11` = character variant, slot 11. What each slot does differs font to font, which is why they are numbered, not named. Check the font's docs. In Inter, `ss01` switches to open digits and `cv11` swaps in a single-story `a`.
