# Layout

Set grouping, alignment, spacing and responsive structure, then stress-test that structure by resizing it, translating it and mirroring it for RTL.

Write every fix in the project's styling system. The numbers below apply only where the project has no spacing scale or density system; otherwise use its tokens. A finding needs a failure you can show, such as a clip, an overlap, a broken mirror or a misread group. A value that differs from these starting points is not one.

Hit areas and focus behavior belong to [accessibility](../accessibility/hit-areas.md) and its [focus rules](../accessibility/focus-and-keyboard.md). Radius and shadows belong to [surfaces](../surfaces.md), animation to [motion](../motion/index.md) and directional icon mirroring to [icons](../icons.md#icons-in-rtl). Line length, text spacing and truncation mechanics belong to [typography](../typography/index.md). The words themselves belong to [writing](../writing/index.md).

Implementation: [web](../../platforms/web/layout.md) · [Apple](../../platforms/apple/layout.md) · [Android](../../platforms/android/layout.md)

## Group with space, not lines

Space groups first, background shapes second, separator lines last and only where space alone can't carry the structure. The gap between groups is at least 2× the gap within one, so `8pt` inside a group means `16pt` or more between groups. Details are in [grouping-and-alignment.md](grouping-and-alignment.md#group-with-space-not-lines).

## Keep controls distinct from content

Give every interactive element a background shape, a border, an underline or a consistent placement zone such as a toolbar. A control styled like the static text beside it does not read as a control. See [grouping-and-alignment.md](grouping-and-alignment.md#keep-controls-distinct-from-content).

## Align to shared edges

Pick a small set of alignment edges and put everything on them. Use one project spacing step per level of nesting, where `16pt` is a useful default. See [grouping-and-alignment.md](grouping-and-alignment.md#align-to-shared-edges).

## Leading and trailing for anything that mirrors

Write direction-dependent layout as leading and trailing (start and end), never left and right: margins, padding, offsets, alignment and corner radii. Reserve physical left and right for geometry that never mirrors. The RTL progression rules are in [grouping-and-alignment.md](grouping-and-alignment.md#leading-and-trailing-for-anything-that-mirrors).

## Order by importance

The most important content sits near the top and the leading edge. Within a row, identifying content leads and metadata and actions trail. Visual order matches the order in code, which is the order screen readers and keyboard focus follow, so never rearrange content visually out of that sequence. See [grouping-and-alignment.md](grouping-and-alignment.md#order-by-importance).

## One primary action per view

Give each view one primary action. Put secondary actions behind a menu once there are more than 3. Prefer a short view that links deeper over one long view that shows everything at the top level. [Color](../color/index.md#fill-exactly-one-action-per-view) owns how color marks the primary action.

## Hint at hidden content

Every piece of off-screen or collapsed content needs a visible cue. Use the project's established cue, let the next item peek `16–32pt` past the scroll edge or show a disclosure control.

A truncated value the user needs has a way to the full text: an expand control, a detail view or a tooltip that is also keyboard-reachable. Truncation mechanics are [typography](../typography/index.md#truncate-with-a-way-back)'s. Details are in [spacing-and-adaptivity.md](spacing-and-adaptivity.md#hint-at-hidden-content).

## Borderless controls need more clearance

Without an established density system, start with `12pt` between adjacent bordered or filled controls. Leave `24pt` between the visible glyphs of borderless text and icon controls, counting each button's own padding. Compact layouts may use less, as long as hit areas never overlap and the controls stay distinct. See [spacing-and-adaptivity.md](spacing-and-adaptivity.md#borderless-controls-need-more-clearance).

## Inset buttons from the edges

In content layouts, keep full-width buttons inside the layout margins, starting near `16pt` inline on phones. Edge-to-edge actions work when they follow established platform chrome, account for safe areas and stay distinguishable from system UI. See [spacing-and-adaptivity.md](spacing-and-adaptivity.md#inset-buttons-from-the-edges).

## Content bleeds, controls float

Backgrounds and media extend to the screen or window edges, under the status bar, the home indicator and translucent bars. Controls and text stay inside the layout margins and the safe area.

Content scrolls beneath sticky chrome. Anchored targets and focused elements scroll to a position below the sticky header, never under it. See [spacing-and-adaptivity.md](spacing-and-adaptivity.md#content-bleeds-controls-float).

## Hold structure until it breaks

Breakpoints come from the content, not device presets or device type. Keep the expanded layout until it stops fitting, then collapse. Adapt a reusable component to the space its container gives it, not to the window size, and test the smallest and largest supported sizes first. See [spacing-and-adaptivity.md](spacing-and-adaptivity.md#hold-structure-until-it-breaks).

## Plan for growth and clipping

Translated strings grow, and short ones grow proportionally more, so a one-word button label is the riskiest thing on the screen. Size text containers by their content, with a minimum and a maximum where needed, never a fixed width or height, and let rows wrap. Test with pseudo-localization and one long-string locale such as German.

Never park a critical action where resizing, zoom, the largest text size or scrolling clips it. Keep it in the normal flow or in stable chrome. See [spacing-and-adaptivity.md](spacing-and-adaptivity.md#plan-for-growth-and-clipping).

## Reference files

| File | Read when |
| --- | --- |
| [grouping-and-alignment.md](grouping-and-alignment.md) | Grouping with space versus backgrounds versus separators, making controls read as controls, setting shared edges, mirroring for RTL, or ordering content by importance |
| [spacing-and-adaptivity.md](spacing-and-adaptivity.md) | Spacing adjacent controls, insetting action bars, cueing hidden or truncated content, full-bleed media and safe areas, content-driven breakpoints and container-relative adaptation, or sizing for translated text, zoom and the on-screen keyboard |

Detection patterns to check before finishing are in each platform file: [web](../../platforms/web/layout.md#before-you-finish) · [Apple](../../platforms/apple/layout.md#before-you-finish) · [Android](../../platforms/android/layout.md#before-you-finish).

## Reporting

**Severity.** `HIGH` blocks content or an action at a supported size. Clipping or overlap at the narrowest supported width (320pt) or at the largest text size or 200% zoom is always `HIGH`, as is truncated content with no way to the full value. So is content past a scroll edge or behind a disclosure with no visible cue. `MEDIUM` harms hierarchy, reading order or adaptability. `LOW` is isolated alignment or spacing polish.

**Verification.** Without rendering, check leading and trailing in place of left and right, size-adaptive branches against the supported size list and code order against visual order. With rendering, check every supported width, the narrowest one, the largest text size or 200% zoom and the RTL mirror. Report every check you could not run as `Not verified`.

**Format.** Group findings under the principle each violates, ordered by severity, one row per root cause listing every location it appears in:

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |

`Location` is `path/to/file:line`. `Why` names the principle and the user impact.

End with `Block` when any `HIGH` remains, `Approve` otherwise, leaving the rest in the table as work to do. Never `Approve` coverage you did not inspect. With nothing to report, state "No actionable layout findings" and report verification.
