# Interface Judgment

Build the smallest complete interface that serves the task: useful product content, a clear title, and the actions people need. Each visible element adds information, enables an action, or provides necessary context. Empty space needs no filler copy or decoration. Correct tokens alone do not make a clear interface. Applies to new screens, custom views, composed components, and revisions to existing screens.

Implementation: [Apple](../platforms/apple/theming.md#interface-judgment) · [Android](../platforms/android/theming.md#interface-judgment); web notes are inline.

## Principles Behind the Rules

The rules in this file and across the skill serve Apple's eight design principles (*Principles of Great Design*, WWDC 2026). Use these as the names you reason with:

1. **Purpose.** Make with intention; decide what *not* to build. Every feature asks for the user's time, attention and trust; spend that budget only where it pays off.
2. **Agency.** Keep people in control: offer choices, don't force a single path. Back it with forgiveness: easy undo for slips, and a confirmation dialog only for genuinely destructive, irreversible actions (use sparingly; overusing it trains people to click through).
3. **Responsibility.** Act in the user's interest. Privacy: ask at the right moment, only for what's needed, transparently. Safety: anticipate misuse and harm, especially with AI (an allergy-aware recipe app must not suggest a harmful ingredient). Add previews, confirmations and disclaimers; cut a feature whose risk outweighs its value.
4. **Familiarity.** Build on what people already know. Use metaphors that are neither too literal nor too abstract (a trash can means delete), and honor their physics. Be consistent: things that look the same must behave the same and live in the same place (close is always top-left on macOS), so people can predict what happens next. Only break a familiar pattern if you can prove it's better, then test it; don't assume.
5. **Flexibility.** Design for different contexts, devices and the full range of abilities. Adapt to the platform (iPhone means quick touch; desktop means deep workflows with precise pointer control) and to the situation. Design inclusively (age, language, expertise, accessibility). When no single layout fits everyone, let people personalize: rearrange controls, hide what they don't use.
6. **Simplicity, not minimalism.** Strip the unnecessary so the core purpose shines; burying everything in one place looks minimal but isn't simple. Be concise (plain language, no jargon, fewer steps) and clear (use hierarchy, through order, spacing and contrast, so the most important thing is the most obvious). Every element earns its place; sometimes *adding* context simplifies (a video scrubber that shows time remaining). Show the common path first, advanced options one level deeper.
7. **Craft.** Uncompromising attention to detail builds trust: beautiful typography, colors that adapt to light and dark, clear iconography, and responsive animations that give immediate, natural feedback. Nothing is random; every spacing, timing and alignment value is a deliberate choice you can defend. Jittery scroll, misaligned icons and layouts that break on rotation read as carelessness. Craft needs iteration and longevity: keep evolving the design as features and hardware change.
8. **Delight.** The result of getting the other seven right, not confetti tacked on top. Decide the emotion you want people to feel (calm, confident, excited) and reinforce it in every decision.

Tactical rules that serve these:

- **Feedback comes in four kinds:** status, completion, warning, error. Confirm meaningful actions, expose ongoing status, warn before problems, validate inline (not on submit).
- **Wayfinding.** Every screen should answer: Where am I? Where can I go? What's there? How do I get out? Never trap the user.
- **Grouping and mapping.** Proximity implies relationship; place a control near what it affects and arrange controls to mirror what they change. If you need a label to explain a control, the mapping is weak.
- **Direct, specific labels beat safe generic ones.** Name nav items for their contents ("Progress", "Library"), not vague umbrellas ("Home"). Specificity creates predictability.

## Start With What the App Already Provides

Inspect surrounding navigation, breadcrumbs, toolbars, actions, and layout before adding page content. If the breadcrumb or back button already provides the return route, another back row adds nothing. Keep extra navigation only when it has a distinct purpose or serves a different responsive context.

A specific product title is a sufficient start. Add metadata only when it helps users understand or act on the content, using information the app actually knows. "Nephew's bookshelf" can stand alone above its books, filters, and an Add a Book action. A title does not come with a subtitle, category label, status badge, or introduction by default. Put a requested summary in the content, not a second version under the title.

## Keep Copy Useful

Omit invented eyebrows (small labels above headings), taglines, sentimental subtitles, motivational empty-state prose, header/footer slogans, and decorative icon-and-text badges. Supporting copy earns its place only by supplying product context the title, content, or controls don't already give. An ordinary app screen is not a marketing hero unless that is the request. Personality comes from the theme and real content, not extra prose.

Explain only what changes the user's understanding, decision, or next action. Omit workflow narration and implementation commentary ("Saved on this device · No account needed") from routine chrome. Surface a storage limit or technical detail at the relevant decision, and only when it has a concrete consequence. A friendly phrase does not need an icon, pill, or status dot; reserve those cues for real categories, actions, or state.

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

When a line break looks wrong, shorten the copy or fix the width; a manual line break or non-breaking space repairs only one width. **Web:** wrapping text inherits `text-wrap: pretty` from the shared typography scope; a manual `<br>` or `&nbsp;` repairs only one viewport.

## Keep Visual Cues Consistent With Behavior

Read-only values (fixed dates, computed totals) render as metadata. Values the user can change use the existing control treatment. A static label never gets a button surface, hover state, chevron, or pointer cursor. Equivalent controls look and behave the same; one shared control drives an input that several views read. Add an interaction only when it serves the task and has real behavior.

## Finish by Removing What Adds Nothing

Review the normal page, its empty states, and its expanded states. For each eyebrow, subtitle, badge, explanation, and footer line, name the distinct information or action it contributes; remove it when there is none. Remove repeated navigation, labels, facts, captions, and style variations when meaning and usability survive. Keep requested content, essential qualifications, accessible structure, useful metadata, and the cues needed to act. A title without supporting copy is a complete design choice.

## Building Components People Love

These principles come from building Sonner, a web toast library (13M+ weekly npm downloads); each Sonner detail below is the worked example, and the principle applies to any component on any platform:

1. **Developer experience is key.** Adoption takes one line and no setup: Sonner needs `<Toaster />` once and `toast()` from anywhere, with no hooks or context. The less friction to adopt, the more people will use it.
2. **Good defaults matter more than options.** Ship beautiful out of the box. Most users never customize. The default easing, timing and visual design should be excellent.
3. **Naming creates identity.** "Sonner" (French for "to ring") feels more elegant than "react-toast". Sacrifice discoverability for memorability when appropriate.
4. **Handle edge cases invisibly.** Pause timers while the app or tab is hidden. Keep the hover region continuous across the gaps between stacked items (Sonner fills them with pseudo-elements). Keep tracking a drag after the pointer leaves the element (Sonner captures pointer events). Users never notice these, and that is exactly right.
5. **Interruptible animation for dynamic UI.** Toasts are added rapidly. An animation on a fixed timeline restarts from zero when interrupted; one that retargets from the current value stays smooth (on the web, transitions rather than keyframes: [interruption](motion/index.md#8-interruption)).
6. **Build a great documentation site.** Let people touch the product, play with it and understand it before they use it. Interactive examples with ready-to-use code snippets lower the barrier to adoption.

## Process

- **Prototype interactively.** An interactive demo is worth "a million static designs." You discover the interface by building and playing with it, and a working prototype sets a concrete bar that prevents a mediocre final implementation.
- **Design interaction and visuals together.** "You shouldn't be able to tell where one ends and the other begins." Motion is not a layer added after the pixels.
- **Test with real people in real context**, and review motion with fresh eyes: play it in slow motion and frame by frame to catch what's invisible at full speed ([debugging](motion/index.md#debugging)).
