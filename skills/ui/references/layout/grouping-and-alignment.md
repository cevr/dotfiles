# Grouping and alignment

Details for grouping, control distinction, shared edges, RTL mirroring and ordering. Implementation: [web](../../platforms/web/layout.md#grouping-and-alignment) · [Apple](../../platforms/apple/layout.md) · [Android](../../platforms/android/layout.md)

## Group with space, not lines

Reach for each tool only where the one before it can't carry the structure:

1. **Negative space**, the default. A form's field groups sit `24pt` apart with `8pt` inside each group.
2. **Background shapes**, a card or filled container, where a group must read as one unit such as a selectable row or a draggable card.
3. **Separator lines**, for dense data where space costs too much, such as tables and long settings lists.

The common failure is uniform spacing between every item with a line under each one to compensate: the lines do the work the spacing should have done.

Where a separator is genuinely needed, keep it a low-contrast hairline. Never pair it with a large gap that already did the job.

## Keep controls distinct from content

An action written as plain text in the same color and weight as the sentence beside it ("Your trial ends soon. Upgrade now") does not read as an action. Mark it with an underline, a weight change, a shape or a placement zone.

The inverse holds too. A non-clickable badge shaped exactly like the buttons beside it collects dead clicks.

## Align to shared edges

- Typical stray edges are an icon 2pt off the text edge and a card padded unlike its neighbor.
- One section inset, such as `24pt`, gives the shared leading edge; a nested child indents by one spacing step, such as `16pt`. Three unrelated leading insets in one column (20, 14 and 24) are the failure.
- Deeper nesting repeats the same spacing step rather than inventing a new one.
- Numbers in tables align to the trailing edge, text to the leading edge. Tabular figures are [typography](../typography/index.md#tabular-numbers-on-changing-values)'s.

## Leading and trailing for anything that mirrors

Express every direction-dependent value as leading (start) or trailing (end): margins, padding, offsets, text alignment, borders on one side and the corners of an asymmetric radius. Each platform has a logical form for these, listed in its layout file.

Rows and columns that follow the reading direction mirror in RTL on their own. Physical left and right values inside them do not mirror, and neither do horizontal translations, background positions or anything positioned by hand from a left or right edge; each of those needs its own RTL override.

Where arrangement encodes progression, as in star ratings, step indicators, sliders and progress bars, the sequence mirrors in RTL. Stars fill from the leading edge, which is the right in RTL. Controls that navigate a fixed order mirror too: a back button points right in RTL. A control that names a real direction ("move right") or points at an area on screen keeps its direction. Digit order inside numbers never reverses; that and other bidi rules belong to [typography](../typography/wrapping-and-punctuation.md#internationalization).

## Order by importance

Never bury the one number the user came for under rows of secondary detail. Move secondary detail into collapsed sections, tabs or detail views.

- **Good:** the balance `$4,320.00` large and first, with "Available balance" small beneath it.
- **Bad:** account number, opening date, tier and last statement date in a stack, with "Balance: $4,320.00" last at the same size as the metadata.
