# Variants

Build several versions of one described piece of UI that differ on purpose, by default three. They go behind a picker in the real page or screen, so you can flip between them and choose.

It produces candidates and never ranks them. Reviewing existing UI is [review](review.md), stress testing one component is [stress-test](stress-test.md) and working through a component's states is [states](states.md).

## Different answers, not different tints

Each variant is a different answer to the same brief, on an axis one reference owns:

| Axis | Owner | What varies |
| --- | --- | --- |
| Structure | [layout](../references/layout/index.md) | Grouping, order, column count, what collapses |
| Density | [layout](../references/layout/index.md) | Spacing scale, how much fits |
| Emphasis | [color](../references/color/index.md) | Where filled color goes, what recedes |
| Type | [typography](../references/typography/index.md) | Scale steps, weight contrast, measure |
| Voice | [writing](../references/writing/index.md) | Labels, tone, how much copy |

Pick **one primary axis** and give each variant a different position on it. The axis names the picker's group heading. Secondary choices follow from it rather than varying on their own. A dense variant may need a smaller type step, and that is coherence, not a second axis.

## The floor every variant clears

Before a variant enters the picker it clears the [review escalation triggers](review.md#6-rank-by-user-impact), which are:

- Every control has an accessible name and a visible focus indicator.
- Keyboard and switch input reach everything a pointer or touch does.
- Motion and auto-playing content respect the reduced-motion setting.
- Nothing clips, overlaps or becomes unreachable at the narrowest supported width (320pt) or the largest text size: 200% browser zoom, the largest accessibility Dynamic Type size, Android font scale 200%.
- Body and control text pass their required contrast ratio.
- No state or meaning rides on color alone, and no state change on motion alone.
- A destructive action has a confirmation, an undo or a distinct treatment.
- Truncated content has a way to reach the full value.
- Nothing hides past a scroll edge or behind a disclosure with no visible cue.
- Every error names a way to recover.
- No semantic color is used against its meaning, such as the danger hue on a non-destructive action.

That floor is identical across variants. It is not an axis and never trades against one. Where a direction can only work by breaking it, say so and drop the direction.

## 1. Scope one piece

One piece of UI per run. "The dashboard" is not a piece; the metric card is. Where the request spans several, list the candidates and ask which one to explore.

Restate the brief in one sentence: what the thing is, where it renders, what it has to do.

## 2. Learn the ground

Variants have to look like they could ship tomorrow, so read what they stand on:

- The styling system, the component library and any motion library.
- The tokens: color, spacing, radius, type scale, easing.
- The product's density and voice. A dense professional tool bounds how far the boldest variant may go.
- Where the piece renders: against what background, beside which neighbours, at which widths.

With no project to read, use neutral grays, one accent and the system font stack, and say that is what you did.

## 3. Name the axis before writing code

Default to three variants. Go to five only when asked.

Write the set down first, a name and an axis position each. Names say what the direction is, so `Quiet`, `Editorial`, `Dense`, never `Option A`.

This step is done when no two variants share a position and you can state each one's axis in a phrase.

## 4. Build it into the real page

Host the variants on the page or screen that will actually contain the piece, with the real chrome, the real neighbours and realistic data. [Harness](harness.md#where-it-lives) covers what a native preview must be wrapped in to render like the app.

Make every variant addressable, so each is one step away and you can send it to someone:

| Web | Apple | Android |
| --- | --- | --- |
| A URL search param such as `?__variant=quiet`, so every variant is a link. A grouped list beside the piece sets it. Where there is no room beside the piece, it moves above it as a select with the same groups | One `#Preview` of the containing screen per variant; in the simulator, the `__variant` launch argument and a debug picker on the real screen | One `@Preview` of the containing screen per variant; on the emulator, a `__variant` intent extra and a debug picker on the real screen |

[picker.md](variants/picker.md) holds the spec.

Render one variant at a time, full size. Thumbnails distort spacing and scale, and spacing is usually the thing you are choosing between.

Variant files may import production components. Only the hosting page or screen imports a variant, and nothing else imports from the harness. On Apple and Android, the variant code and its picker compile only in debug builds.

On the web, where no page can host it, build one self-contained HTML file and keep the same picker.

Give every variant real content: product-shaped copy, plausible names and the number of items the page will really carry. Lorem ipsum and three rows make every structure look good.

## 5. Present the tradeoffs and stop

Render the host once, using the renderer [harness](harness.md#looking-at-it) names for the platform, and flip through every variant. Each one renders, each interaction responds and the log is clean: the browser console, Xcode's console with no runtime warnings, Logcat with no errors. With no way to render at hand, say so and hand over the URL or the preview file and names for the user to check.

Then hand the decision over:

| Variant | Axis position | Right when | Costs |
| --- | --- | --- | --- |
| Quiet | Lowest visual weight | The page is used daily | Least memorable |
| Editorial | Largest type, most space | The moment deserves weight | Eats vertical space |

Say where the picker is running, how to flip it and which width you judged at. The answer can change between 375 and 1440 on the web, between compact and regular size classes on Apple and between compact and expanded window size classes on Android.

Never mark a favourite in the table. Asked directly, answer from how often the piece is seen and from the product's personality, not from which one you enjoyed building.

## 6. Promote one, delete the rest

On a choice, build that variant properly where it belongs, following the project's own conventions. Then delete the other variants, the picker and the guarded import. Search for the variant names and `__variant`, and check the diff leaves nothing of the harness behind.

Asked for another round instead, keep the harness and run **Name the axis before writing code** again, taking new positions around the direction you leaned toward.

## Before you finish

| Mistake | Fix |
| --- | --- |
| Variants differ only in accent color or copy | Move one to a different position on the primary axis, or cut it |
| Every axis varies at once | Vary one; let the rest follow from it |
| Judged on a blank route or an isolated preview | Host them on the page or screen that will contain the piece |
| Lorem ipsum, three rows, "Jane Doe" | Real copy and the item count the page will really carry |
| The boldest variant skips keyboard or focus | Clear the floor or drop the direction |
| A favourite marked in the table | State each variant's cost and let the user choose |
| Picker restyled with the project's tokens | Keep it visibly outside the design system |
| One long row of tabs, one per variant | Web: a grouped list beside the piece that scrolls on its own, a select above it where the list does not fit. Native: one named preview per variant |
| Harness left behind after promotion | Delete it and search for the names and `__variant` |
