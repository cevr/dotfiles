# Dashboards

Screens people work in rather than read: dashboards and overviews, admin and back-office lists, analytics and reports. This file covers their KPIs, charts, tables and data states.

The generated dashboard is the average of every template: a tinted sidebar with a colored active pill, a "Welcome back" greeting, four KPI cards each with an icon in a tinted circle, a green "+12.5%" and a sparkline, a gradient area chart, and a zebra table under uppercase headers. Nothing in it is wrong and none of it was decided. Removing those devices is half the job. The other half is the product's own data, a screen that answers its one question first, and a grid whose sums close.

Other references own the rules this file builds on: where each fact lives and chart titles in [interface judgment](interface-judgment.md#give-information-a-clear-home), data and activity states in [async states](async-states.md), alignment and grouping in [layout](layout/index.md), a change's good or bad color in [color usage](color/color-usage.md#one-color-one-meaning), tabular figures in [typography](typography/index.md#tabular-numbers-on-changing-values), chart color cues in [accessibility](accessibility/index.md#pair-color-with-a-second-cue). The project's theme and chart library decide values first ([precedence](../SKILL.md#precedence)).

## Start from the question

Before any markup, write down:

- **The one question** the screen answers first: "Did today's orders ship?", "Which deploy broke?", "Who is waiting for a reply?". The biggest block answers it, and the largest figure on screen answers the title's sentence.
- **The one finding**: the fact in today's data that most needs attention ("the 23:28 deploy doubled the error rate"). It goes where it is read first, as the line under the title or the subline of the headline figure, beside the action it drives, never in a caption at the foot of a card.
- **The next questions**, one per block. A block that answers no question is deleted. This replaces the stock order of KPI row, big chart, two small charts, table. A few numbers that say it need no chart.
- **The most frequent job** ("pack today's orders", "redeploy the failed build") and its control, placed where the answer shows: a primary action in the title row, or an action on the row that needs it. A screen with no control for its main job is a report, not a tool.

Every block the brief names shows its header and its first rows on the first desktop screen. Size the headline block to the question, cap overview lists at 4–6 rows with a "View all" and the total, and put time-sensitive blocks (bills due, a failed deploy) before long tables. An overview never paginates.

The title is a noun (the screen's or the object's name), not a greeting; a greeting suits a personal home only. The shell names the product and its scope (the workspace, team or account): a screen whose product can't be named from a screenshot reads as a template. Navigation recedes: the sidebar sits on the page's ground and the active item takes a neutral fill or a brighter label, so the accent stays on the data and at most one control ([color](color/index.md#fill-exactly-one-action-per-view)).

## Sample data that holds up

[Content realism](../SKILL.md#aesthetic-direction) covers names and totals summed from their rows. On a data screen, also:

- Render every block from one dataset file, and assert the figures that must agree in it: the parts sum to the whole, sold minus cancelled equals the count shown.
- **A fact shown twice is one variable.** A time window, a total or a state that appears in two blocks comes from one value, and the copy and the chart annotation are built from it.
- **Totals and changes come from the values as displayed**: sum the rounded figures on screen, and take a change as the difference of the two displayed values.
- **Every relative figure names its baseline** in the same phrase: "+5 on the usual Monday", "45 min earlier than last Sunday". A bare "+5" reads as measured against whatever sits beside it.
- **Small numbers stay small.** A new account shows its 1, 6 or 9 of something at its real size, and no growth percentage on a week-old account.

## KPIs

- **Type, not tiles.** A KPI is a label over a number. Peers share one container split by hairlines into equal columns, or each headline number sits in the block that explains it, which is often better. The column count equals the KPI count: four KPIs in a three-column grid orphan the fourth.
- **Nothing else on it.** No icon in a tinted circle, no sparkline, no tinted tile: the trend gets its own chart, or nowhere. An info glyph beside the label is fine. Units are a smaller muted suffix ("5 min", "12 /20").
- **The label above, sentence case and muted; the value about 1.7× the label**, at regular to semibold weight in the primary text color, never in the brand color. No figure on a working screen reaches display size (`48pt` and up).
- **The answer figure leads.** When one figure is the screen's answer (a balance, a portfolio's value), it is at least 1.3× its siblings, and no other figure on screen is larger.
- **One figure, one place** ([interface judgment](interface-judgment.md#give-information-a-clear-home)). A KPI strip whose every cell restates a panel below is dropped; lead each panel with its own number.
- **KPIs as tabs** (switching a chart's metric) mark the selected one with a rule or the active fill and keep every value in the primary text color. A muted value reads as disabled.

**Deltas** are optional. A delta is no larger than its label, names its window in words ("vs prior 30 days") and colors only the number. Which color, and how a zero or a change from zero reads, is [color usage](color/color-usage.md#one-color-one-meaning)'s.

## Charts

Pick the form from the question:

| Question | Form |
| --- | --- |
| Is it moving over time? | One line; an area only with a flat fill at about 15% opacity or less |
| How much per period? | Columns with square corners, or at most a `4pt` top radius |
| How is it distributed? | A histogram with equal bins |
| Who ranks? | A sorted horizontal bar list |
| What share? | A thin ring or a 100% stacked bar, five parts at most |
| How far to the target? | A progress bar at the true ratio, both ends labelled |

- **One question, one series.** Three series at most; to show another metric, switch it with a control (a segmented control, the KPIs as tabs) instead of overlaying lines.
- **Axes**: 3–5 faint horizontal gridlines, no y-axis line, the baseline the one heavier line. 4–7 round, even ticks (0, 5, 10, 15), the top tick above the maximum, zero as the baseline for bars and counts, integers for counts. Never a chart without a scale. Axis text is no larger than the data text. 4–8 x labels, never rotated, and time on a time scale.
- **Marks**: lines at `2pt` in straight segments, since smoothing invents values between points; no point markers except on hover. A tooltip is plain: the label and the value on one line.
- **Color**: one hue per chart, on the screen's main data element (today's series, the current period), not on a secondary chart. One subject keeps one hue across the screen, four hues per screen at most, and status colors only for status ([theming](theming.md#color-by-role-not-palette)).
- **Legends**: none for a single series, whose title names it. Otherwise five items at most, in the block's header, each swatch the mark itself scaled down, and never a series with no data. When a caption has to say which bars are which, encode it in the chart instead.
- **Rings** only for three to five parts not already listed beside them: a thin stroke, no labels on the slices, the total in the center or beside it.
- **Annotate the event that matters.** A step or spike several times the usual change gets a `1pt` marker and a short label naming its cause ("Deploy a3f09c1"). A reference line (a budget, an SLO) is `1pt` dashed with its label at the end. Labels never collide with a line or each other.
- **A forecast is not a fact**: past today the line is dashed, with its end value labelled.
- **Size to the data.** A series flat except for one event takes at most two-thirds of the width, with the next answer beside it.
- **Short and empty histories are drawn honestly**: a flat zero line, missing bars for empty periods, no padded range, no "No data" illustration. A single point never gets the screen's largest plot.

## Tables and lists

- **Header**: muted, regular weight, sentence case, no fill band, no uppercase tracking. Numeric headers align to the trailing edge, flush with their values. A sort glyph on the active column only.
- **Rows**: no zebra striping. Space or a `1pt` rule a few percent darker than the surface separates them, with one rule extent per screen.
- **Figures** align to the trailing edge in tabular figures ([layout](layout/grouping-and-alignment.md#align-to-shared-edges)), formatted through the platform's locale-aware number formatter: fixed decimals per metric (money 2, percentages 1 or 2, counts 0), grouping separators, a sign on every change. Every trailing-aligned figure in a row or card ends on one edge.
- **Ink**: the identity and the key number in the primary text color, everything else muted. The sign lives in the text, not in red on every negative.
- **Width**: the identity column gets the most and is never the one truncated while another column has room. Two measures stack in one cell on one trailing edge (a count over its percentage) rather than taking two columns.
- **Status**: a pale tint with dark text of the same hue; a saturated fill only for a call to action that stays rare. One status mark per row. A chip never shrinks or wraps.
- **Actions**: none, or one overflow menu at the trailing edge. A row that needs doing (an order to pack, a failed deploy) gets a visible action in one fixed trailing column at every row's pitch. Checkboxes only where bulk actions exist.
- **A full list screen** states the total above the table, keeps the header in view while scrolling, and pages with the range shown ("1–50 of 1,284").
- **A bar inside a list** stays thin and muted unless it is the screen's main series. A row's fill used as its bar works only in a one-figure ranking list, where it can't cut through words.

## Data states

The data and activity pairs, inline errors, a real zero against a missing value, and a region that holds still are [async states](async-states.md)'. On a data screen, also:

- **Counts follow the view.** A count in a tab, a KPI or a header ("12 open") is computed from the rows in the current view and filter, and recomputed on every switch. A filtered block shrinks to its rows, or keeps its row count with one sentence in the empty space.
- **An empty block keeps its frame and its header** and adds one sentence spanning it. An empty side block can show reference data instead: "Nothing has sold out yet" over last week's sell-out times.
- **First run** keeps the frame and the title and puts the first action where the data will appear, with setup progress at its true percentage.
- **Loading** is the final layout with each value replaced by a flat muted bar at its real size, every label and header shown at once, and no shimmer.
- **An error** says what failed and when the data was last good ("Couldn't load deployments. Last updated 09:14."), with a retry, inside the block that failed.
- **Freshness**: data that refreshes carries a stamp ("Updated 4:09 PM") and a refresh action; a snapshot that can't refresh says so once.
- **Red is a signal, not a texture**: one negative mark per object at most, on the overdue or failing fact.

Data on screen moves only to show a real change ([motion](motion/index.md#2-what-is-the-purpose)), and nothing on a working screen performs an entrance.

## Grid and density

- **The grid fits the data.** Choose the column count from the item count, let a lone block span, and never stretch a block over empty space. Blocks that share a row share a bottom edge: balance them by content (one row cap for two lists side by side), or stack them.
- **Narrow blocks don't span the canvas.** A table of five columns or fewer, or a list of six rows or fewer, pairs with the next block at desktop width instead of leaving a void between a name and its first figure.
- **One gutter**, horizontally and vertically.
- **Density is three settings moved together**: row pitch, padding and type size. Smaller type inside the same padding is not density.
- **Resting blocks sit flat**: a hairline or one tone step separates them, and shadows stay on what floats ([surfaces](surfaces.md#shadows-for-elevation-borders-for-structure)).

## Compact width

- Navigation folds into a top bar with a menu, or a bottom bar of four or five destinations.
- KPIs become a two-column grid with an even count, or a list with the label leading and the value trailing, never four squeezed columns.
- Tables become two-line rows: the identity and the key number on line 1, the other fields muted on line 2. Fields move; they are never dropped. A table that must stay a table scrolls inside its own frame with the identity column fixed, and the page never scrolls sideways.
- A block that carries an action moves up as a one-line summary row ("5 items low · Review"), never below a long list.
- A list and its detail show one pane at a time; back returns to the list at its scroll position.
- At most one row of controls sits above a chart.

## Before you finish

Answer each from the rendered screenshots, at every width ([judging it](../workflows/harness.md#judging-it)):

1. The biggest block answers the screen's one question, and the largest figure answers the title.
2. The one finding is read first, beside the action it drives.
3. Color sits on data, status and the one primary action, and the main data element carries the one hue.
4. Every fact shown twice agrees, every total and change recomputes from the values as displayed, and every relative figure names its baseline.
5. Every zero reads as a zero, every missing value as a dash, and every count follows the current view.
6. Every legend swatch matches its mark, and no label collides with another or with a line.
7. At compact width, navigation is folded and each block still answers its question.
