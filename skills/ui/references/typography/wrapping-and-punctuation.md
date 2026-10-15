# Wrapping and punctuation

Line length, typographic characters and mixed-direction text. Implementation: [web](../../platforms/web/typography.md#measure) · [Apple](../../platforms/apple/typography.md) · [Android](../../platforms/android/typography.md).

## Measure (line length)

Any unit works, as long as the line lands at 60–75 characters. At a `16pt` body size that range lands roughly between `560pt` and `680pt` depending on the font. Recheck the cap if the body text size changes. **Web:** `65ch`, Tailwind's `max-w-prose`, or a `px`/`rem` cap.

## Smart punctuation

| Instead of | Use |
| --- | --- |
| Straight quotes `"..."` | Curly quotes that curve around the text (keep straight quotes in code) |
| Hyphen in ranges | En dash: `2010–2020` |
| Two hyphens for an aside | Em dash character |
| Three periods `...` | The single ellipsis character `…` |
| Regular space in `10 km`, `⌘ K`, or a multi-word brand name | A non-breaking space (U+00A0, `&nbsp;` in HTML) so the value never breaks apart |
| Opening quote mark in word-initial elisions (`‘70s`, `rock ‘n’ roll`) | Apostrophe `’`, which points down: `’70s`, `rock ’n’ roll` |
| Uncontrolled word breaks | A soft hyphen (U+00AD, `&shy;` in HTML) to mark where a word may break, or automatic hyphenation with the correct language set |

## Internationalization

- **Long paragraphs align by their own language.** A one- or two-line snippet follows the surrounding UI's direction. A paragraph of three or more lines aligns to its own script instead, so an English paragraph stays start-aligned LTR even inside an RTL interface. Start alignment with the paragraph's language and direction set handles this.
- **Digits keep their order.** A phone number or "541" reads identically in RTL, because the Unicode bidi algorithm keeps digit runs left to right. Isolating the value (**Web:** `<bdi>`) repairs one whose order adjacent RTL text disturbs.
