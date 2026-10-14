# Interface Judgment

Build the smallest complete interface that serves the task: useful product content, a clear title, and the actions people need. Each visible element adds information, enables an action, or provides necessary context. Empty space needs no filler copy or decoration. Correct tokens alone do not make a clear interface. Applies to new routes, custom markup, composed components, and revisions to existing screens.

## Start With What the App Already Provides

Inspect surrounding navigation, breadcrumbs, actions, and layout before adding page content. If the breadcrumb already provides the return route, another back row adds nothing. Keep extra navigation only when it has a distinct purpose or serves a different responsive context.

A specific product title is a sufficient start. Add metadata only when it helps users understand or act on the content, using information the app actually knows. "Nephew's bookshelf" can stand alone above its books, filters, and an Add a Book action. A title does not come with a subtitle, category label, status badge, or introduction by default. Put a requested summary in the content, not a second version under the title.

## Keep Copy Useful

Omit invented eyebrows (small labels above headings), taglines, sentimental subtitles, motivational empty-state prose, header/footer slogans, and decorative icon-and-text badges. Supporting copy earns its place only by supplying product context the title, content, or controls don't already give. An ordinary app screen is not a marketing hero unless that is the request. Personality comes from the theme and real content, not extra prose.

Explain only what changes the user's understanding, decision, or next action. Omit workflow narration and implementation commentary ("Saved on this browser · No account needed") from routine chrome. Surface a storage limit or technical detail at the relevant decision, and only when it has a concrete consequence. A friendly phrase does not need an icon, pill, or status dot; reserve those cues for real categories, actions, or state.

Empty states: say what is missing when it isn't already clear, and give the next useful action. Skip the slogan, the paraphrase of the section title, and the explanation of what the button label already says. One action at the point of need; repeat it only when placement or a different responsive context makes it useful. Keep required labels, validation, accessibility, and instructions that prevent a real mistake.

## Give Information a Clear Home

Assign each fact a primary place. Summary prose explains significance, a KPI highlights a value, a chart exposes a trend or comparison, a table supports exact lookup. These coexist when they answer different questions. Don't repeat the same headline value in prose, a KPI, and a chart header at equal emphasis. A chart and an expandable data table can share data because they support different tasks.

Chart titles are descriptive. Add a caption only for interpretation the surrounding content lacks. Keep units, series identification, meaningful date ranges, and definitions needed to read the chart. When several views share a period, state it once at their common scope; label differing periods where they differ.

After a disclosure such as "View monthly data", reveal the data directly. Let the heading or disclosure label name the region; add a visible caption only if it adds information. Keep semantic table headers and accessible names. If data is illustrative, say so once in a relevant place, not as a badge on every card.

## Reuse a Small Visual Vocabulary

Choose the smallest useful subset of the theme's text steps, font roles, and weights. A new section does not need a new style. Peer card and chart headings share size and weight; equivalent values, labels, and metadata look the same across views. A page title or focal metric can take a distinct role when the difference explains hierarchy. Semantic heading levels and visual styles are separate: keep a meaningful document outline while styling peers consistently.

Regular paragraph text by default. Emphasize a phrase only when it materially helps scanning; don't bold a metric just because it is a number, especially beside a callout that already gives it prominence. Reach for spacing and grouping before another font size, weight, color, surface, or divider.

## Make Widths and Alignment Deliberate

Set prose in a readable column and align related headings, paragraphs, and data regions to a shared grid. Short copy can end before the right edge. A wide chart or table can sit below narrower prose when the relationship is clear. Choose container and text widths together; an unexplained narrow text column inside a much wider bordered or filled box reads as a mistake. Never justify text, add filler, or enlarge type to fill a box. Reflow on narrow screens while keeping type and controls readable.

Wrapping text inherits `text-wrap: pretty` from the shared typography scope. When a line break looks wrong, shorten the copy or fix the width; manual `<br>` and non-breaking-space patches only repair one viewport.

## Keep Visual Cues Consistent With Behavior

Read-only values (fixed dates, computed totals) render as metadata. Values the user can change use the existing control treatment. A static label never gets a button surface, hover state, chevron, or pointer cursor. Equivalent controls look and behave the same; one shared control drives an input that several views read. Add an interaction only when it serves the task and has real behavior.

## Finish by Removing What Adds Nothing

Review the normal page, its empty states, and its expanded states. For each eyebrow, subtitle, badge, explanation, and footer line, name the distinct information or action it contributes; remove it when there is none. Remove repeated navigation, labels, facts, captions, and style variations when meaning and usability survive. Keep requested content, essential qualifications, accessible structure, useful metadata, and the cues needed to act. A title without supporting copy is a complete design choice.
