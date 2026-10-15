# Spacing and adaptivity

Details for control clearance, edge insets, disclosure cues, edge behavior, breakpoints and growth. Implementation: [web](../../platforms/web/layout.md#spacing-and-adaptivity) · [Apple](../../platforms/apple/layout.md) · [Android](../../platforms/android/layout.md)

## Borderless controls need more clearance

| Between | Starting point |
| --- | --- |
| Adjacent bordered or filled controls, such as buttons and inputs | `12pt` |
| Visible glyphs of borderless controls, such as text and icon buttons | `24pt` |
| Unrelated control groups | `24pt` or more |

Nothing marks where one borderless target ends and the next begins, so the space is the boundary. Three borderless icon buttons packed `4pt` apart read as one blurred cluster. Preserve an established, usable density rather than expanding controls to match these values.

Target sizes and hit-area expansion belong to [accessibility](../accessibility/hit-areas.md). Space controls so their expanded hit areas never overlap.

## Inset buttons from the edges

A button pressed against the screen edge looks like system chrome and clips against curved corners and gesture zones. Inset an action bar `16pt` inline and `16pt` above the bottom safe area; the button can still span the full content width inside those margins.

## Hint at hidden content

- **Peeking items.** A row of cards that ends exactly at the container edge looks complete, and nobody scrolls it.
- **Disclosure controls.** A collapsed section gets a chevron or a "Show more" control naming what is hidden: "Show 12 more results", not "More".
- **Truncated values.** Pair the clamp with an expand control, a link to a detail view or a tooltip that also opens on keyboard focus. A hover-only tooltip does not count, because keyboard and touch users never see it.

The item width sets the peek: item width = container content width + gap − peek. With a `24pt` content inset, a `12pt` gap and a `24pt` peek, each item is the content width minus `12pt`. Snapped items align to the content inset, not the container edge.

## Content bleeds, controls float

- Full-bleed media inside a constrained article spans the whole width while the text column stays at its measure.
- Safe-area insets come from the platform. A floating button offsets `16pt` plus the safe-area inset from the trailing and bottom edges, and moves to the other side in RTL.
- Sticky headers: the scroll position of an anchored or focused element accounts for the header's height.

## Hold structure until it breaks

Break where the layout stops fitting, not at a preset width such as `768pt` or a device class such as "tablet". That is where the sidebar squeezes content below its minimum measure, or a card grid drops below a usable column width.

A component adapts to the width its container gives it. A card that switches to one column when the window is narrow still breaks inside a narrow sidebar on a wide window; one that reads its container's width does not. Window-level structure (sidebar or tabs, one pane or two) follows the window's size class.

## Plan for growth and clipping

- **Labels define their size.** A button takes its label's width plus padding, capped at the available width, and a row of buttons wraps. A button fixed at `96pt` with its overflow hidden fails in German.
- **Flexible columns shrink.** In a row, the text column takes the flexible share and may shrink below its content's natural width; fixed items such as an avatar or a menu button keep their size. Otherwise long words and wide tables push siblings past the screen edge.
- **No fixed heights on text.** Fixed-height containers clip text at the largest text size, at 200% zoom and in long locales. Use a minimum height where a floor is needed. Where a box must cap its height, scroll its overflow.

Typical clip-prone spots are the bottom edge of a resizable pane, the bottom of a modal taller than the screen and anything the on-screen keyboard covers:

- Size full-height panes to the visible area, which changes as browser toolbars and the keyboard show and hide.
- Cap a modal at the visible height, scroll its body, and keep its action row outside the scroll area.
- Keep primary actions in stable chrome, such as a sticky footer with safe-area padding or the top of the view.
