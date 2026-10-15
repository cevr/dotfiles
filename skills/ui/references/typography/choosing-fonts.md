# Choosing fonts

Font categories, routes for a type change and why fonts look the way they do. Font files and fallback code per platform: [web](../../platforms/web/typography.md#fonts-and-synthesis) · [Apple](../../platforms/apple/typography.md#fonts) · [Android](../../platforms/android/typography.md#fonts).

## Choosing a typeface

| Category | Traits | Use for |
| --- | --- | --- |
| Serif | Small strokes at the ends of letters guide the eye along a line | Long passages, editorial reading |
| Sans-serif | Clean, even shapes that stay crisp at small sizes | Default for most interfaces (Helvetica, Inter, Geist) |
| Monospace | Every glyph the same width | Code and fixed-width identifiers; numeric columns use tabular figures instead |
| Display | Drawn for large headlines | Marketing headlines, hero text |
| Script | Mimics handwriting | Rare, decorative moments |

"Display" in a font's name does not make it a display font. SF Pro and Heldane ship a `Display` variant for large sizes and a `Text` variant for small ones. Use the variant matching the size you are setting, unless the family sizes optically on its own.

## Routes for a type change

When a type change is asked for, two routes:

- **The platform's own interface face:** `system-ui` on the web, SF Pro on Apple, the device default (Roboto on most Android devices). It needs no files and matches the system.
- **A commercial or brand face** such as Helvetica Now: a brand decision. It still needs fallbacks for the scripts and weights it lacks.

## Anatomy of a typeface

| Term | Meaning |
| --- | --- |
| x-height | Height of a lowercase `x` |
| Cap height | Height of uppercase letters |
| Baseline | The invisible line letters sit on |
| Ascender | Part of a letter rising above the x-height |
| Descender | Part dropping below the baseline |

These measurements are why two fonts at the same size look like different sizes. A large x-height looks bigger.
