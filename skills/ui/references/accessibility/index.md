# Accessibility

Review and fix semantics, keyboard and focus behavior, accessible names, forms, announcements, motion and text size. Report each failure against the WCAG criterion it breaks and write the fix with the platform's own API in the project's styling system.

Reviewing means two walks. Keyboard-only (or Switch Control / Switch Access), where every flow completes without a pointer or touch. Then screen-reader (VoiceOver, TalkBack, NVDA), where every control announces a name, a role and its state. When unsure, take the platform's native control over a custom rebuild, and remove accessibility overrides rather than add them.

Contrast measurement and color fixes belong to [color](../color/index.md). Text sizing, iOS input zoom and language metadata belong to [typography](../typography/index.md). Spacing between targets and spatial RTL belong to [layout](../layout/index.md). Label, error and alt-text wording belong to [writing](../writing/index.md). Animation recipes belong to [motion](../motion/index.md). Hover gating, tap highlight and scroll containment belong to [mobile web](../../platforms/web/mobile.md).

Implementation: [web](../../platforms/web/accessibility.md) · [Apple](../../platforms/apple/accessibility.md) · [Android](../../platforms/android/accessibility.md)

## Criteria, not conventions

A finding cites a WCAG 2.2 Level A or AA criterion by number, or a concrete task an assistive-technology user cannot complete. Native apps are held to the same criteria; W3C's WCAG2ICT guidance maps them. Everything else is a recommendation and never `HIGH`. That covers AAA criteria, platform pattern guides (ARIA APG, the HIG, Material), the one-top-heading and no-skipped-levels outline, and platform target sizes above the 24 pt criterion. The criterion thresholds below are exact. The larger targets are what to build to; in review, keep an established, usable density.

## Native controls first

Every control exposes a role, a name and its current state (4.1.2). The platform's native control supplies all three, plus focus and keyboard behavior, for free; a custom control rebuilds every piece, and its role is a promise of the full keyboard model, states and behavior. A wrong role is worse than none, because a screen reader trusts it.

An action is a button; anything that goes somewhere is a link. A "button" that navigates is a styled link, and a "link" that performs an action is a styled button.

**Web:** the first rule of ARIA is to use the native element instead. `<button>` for actions, `<a href>` for navigation, never `<div onClick>`; a real link supports Cmd/Ctrl/middle-click. Element choice, landmarks and ARIA are in [semantics-and-aria.md](../../platforms/web/semantics-and-aria.md).

## Disabled means unavailable

Use the platform's disabled state when a control is genuinely unavailable; it suppresses activation and usually leaves the focus order. A disabled control can't show a tooltip to keyboard or touch users, so put the reason in visible text beside it, or keep the control focusable, announce it as unavailable and block activation in code. Disabled controls are exempt from contrast minimums.

**Web:** native `disabled` versus `aria-disabled="true"`, in [semantics-and-aria.md](../../platforms/web/semantics-and-aria.md#disabled-states).

## Visible focus rings

Keyboard focus is always visible (2.4.7): keyboard users get an indicator and pointer users usually don't. Prefer the platform's unmodified indicator.

A custom indicator needs a project focus token or another explicit color. It must reach 3:1 against every adjacent color it crosses, the inherited foreground color included, under 1.4.11. A 2 pt solid perimeter with a 3:1 change of contrast is the 2.4.13 AAA target. Never remove the indicator without a verified replacement, and preserve system colors in high-contrast modes.

A focused element must never sit fully hidden behind a sticky header, footer or banner (2.4.11): the scroller reserves the sticky element's height. Details are in [focus-and-keyboard.md](focus-and-keyboard.md).

## Full keyboard support

Every pointer interaction needs a keyboard path (2.1.1), and switch and voice control reach the same actions. Tab moves between controls, arrow keys move within composite widgets, Enter and Space activate, and Escape (Back on Android) closes the topmost overlay.

Focus order follows reading order (2.4.3); fix it in the structure, never with ordering overrides. A composite widget (tabs, menu, toolbar, radio group) is one Tab stop. Key maps per widget are in [focus-and-keyboard.md](focus-and-keyboard.md#keyboard-patterns).

## Trap and restore focus

Prefer the platform's modal presentation, which makes the background inert and handles Escape or Back. A custom overlay announces itself as a dialog, removes the background from focus and from assistive tech, and handles dismissal itself. Either way, move focus inside on open and return it to the trigger on close.

A view change updates the window or screen title and moves focus to the new view's heading. Client-side web routing does neither on its own. Both rules are in [focus-and-keyboard.md](focus-and-keyboard.md).

## Minimum hit area

WCAG 2.5.8's Level AA baseline is a 24×24 pt target, or one of its exceptions. Build to the platform's minimum: 44×44 pt on Apple, 48×48 dp on Android, and on the web 44×44 on touch and 40×40 on desktop where density permits. Extend the hit area beyond the visible element when the visible element should stay smaller.

Never let extended hit areas overlap. Decorative layers pass input through, so a glow never swallows the taps meant for the control beneath it.

Every drag interaction needs a single-pointer alternative, such as buttons or a menu that reorder or move the same item (2.5.7). Sizes, exceptions and collision rules are in [hit-areas.md](hit-areas.md).

## Label and type every control

Every input gets a visible label tied to it programmatically. A placeholder is never a label. Label and control share one hit target, with no dead zone between a checkbox and its text.

Fields about the user declare their content type, so autofill and password managers work (1.3.5), and the field type summons the right keyboard. Never block paste; users paste passwords and one-time codes. See [forms.md](forms.md).

## Errors that announce

Validate on submit, never by disabling submit until the form is valid. Mark failing fields invalid, tie the inline error text to its field so it is read with it (3.3.1), and focus the first invalid field. Submit behavior while the request runs is in [forms.md](forms.md#submit-behavior).

## Accessible names

Every control has an accessible name (4.1.2). Icon-only buttons need a name that describes the action. Prefer visible text as the name; a separate name drifts out of sync with the interface. Visible label text must appear in the accessible name, at its start (2.5.3 Label in Name), because a voice-control user says what they see: a button showing "Send" named "Submit message" breaks "click Send". Decorative elements are hidden from assistive tech, never a focusable element or its ancestor.

**Web:** visible text or `aria-labelledby` over `aria-label`; name precedence and examples are in [semantics-and-aria.md](../../platforms/web/semantics-and-aria.md#accessible-names).

## Don't rely on color alone

Status needs a redundant cue: an icon, text or an underline alongside the color (1.4.1).

Accessibility decides which contrast requirement applies:

| Criterion | Applies to | Minimum |
| --- | --- | --- |
| 1.4.3 AA | Text | 4.5:1 |
| 1.4.3 AA | Large text, at least 24 pt or 18.67 pt bold (WCAG's 18 and 14 print points) | 3:1 |
| 1.4.11 AA | UI component boundaries, states and meaningful graphics | 3:1 |

Inactive controls and logos are exempt. Measure the rendered pair with the [contrast reference](../color/contrast.md). When it fails, report the pair and the criterion it misses, and leave the colors alone unless asked.

## Honor reduced motion

Motion is opt-in behind the system's reduced-motion setting. Under reduced motion, replace slides and scales with opacity crossfades, and kill parallax and autoplay entirely. See [motion-and-zoom.md](motion-and-zoom.md).

## Nothing the user needs runs on a timer

Anything moving, blinking or updating on its own for more than 5 seconds needs a visible pause control (2.2.2). Toasts carrying an action or an error stay until dismissed. The rules are in [motion-and-zoom.md](motion-and-zoom.md#autoplay-and-timed-ui).

## Announce dynamic content

Three mechanisms, three jobs. A description on the field carries field-specific validation. A polite announcement carries non-urgent updates not tied to a control, such as toasts and result counts. An assertive one carries urgent untied errors and nothing else.

Repeated polite announcements need a stable empty region present before its text updates. Dynamically inserted urgent announcements vary in support, so test them on the screen readers you target. See [screen-readers.md](screen-readers.md).

## Alt text by purpose

Decorative images are hidden from assistive tech. Informative images describe the meaning. Functional images describe the action, never the picture. The full table is in [screen-readers.md](screen-readers.md#alt-text).

## Structure is navigation

Use headings that describe their sections, are marked as headings so screen-reader users can jump between them, and form a coherent outline. Headings are structure, not styling: the level follows the outline and the text style is chosen separately. The window or screen title matches the current context, most specific first: `Billing · Settings · Acme` (2.4.2). When repeated navigation or chrome precedes the main content, give keyboard users a way past it (2.4.1). **Web:** one visible primary `<main>` landmark and a "Skip to content" link as the first focusable element ([focus-and-keyboard.md](focus-and-keyboard.md#bypass-blocks)).

## Survive zoom and text resize

Text must survive 200% resize through the platform's text-size setting (1.4.4), and the screen must reflow at 320 pt width with scrolling in one direction only (1.4.10). Text containers take a minimum height, not a fixed one, and [layout](../layout/spacing-and-adaptivity.md) owns the rest of that fix. Never block the user's zoom. **Web:** never set `maximum-scale=1` or `user-scalable=no` in the viewport meta; iOS input zoom is fixed with the [16px input rule](../../platforms/web/typography.md#ios-input-zoom) instead.

## Interaction details

- **List editing.** In a sequential list, ⌘/Ctrl+Backspace deletes the focused item, and focus moves to its neighbor.
- **Input adornments.** Prefix and suffix icons sit over the input's padding; tapping one focuses the input.
- **Autofocus** only on desktop when a screen has one primary input, rarely on touch devices, where the keyboard pops and the layout shifts. Flag any autofocus with no stated reason.
- **Submit once.** A submit that has started carries an idempotency key, so a retry or double press can't apply twice.
- **Drag.** The element being dragged leaves the focus order and the assistive-tech tree while it moves, and the drag surface suppresses text selection. **Web:** `inert` on the dragged element.
- **Nested menus** keep a prediction cone (safe triangle) so diagonal pointer travel toward a submenu doesn't close it.
- **Help.** Inline help first, tooltips last. A hover tooltip holds no interactive content.
- **Content images** are real images with a description, not background decoration, so screen readers and copy work. **Web:** `<img>` with alt text, not CSS backgrounds.
- **Charts** use a color-blind-safe palette and pair every hue with a label, pattern, or position (see [Don't rely on color alone](#dont-rely-on-color-alone)).

## Reporting

**Severity.** `HIGH` prevents a task, hides content from assistive technology or creates a systemic failure. `MEDIUM` makes an interaction meaningfully harder. `LOW` is isolated polish. This domain's share of the [cross-discipline review](../../workflows/review.md)'s escalation triggers is `HIGH` on sight. That is a missing accessible name, a missing focus indicator and a pointer path with no keyboard path. It is also motion ignoring reduced motion, loss at 320 pt or 200% text and meaning carried by color alone.

**Verification.** From source alone: accessible names on every interactive element, keyboard handling on custom controls, focus styles, reduced-motion guards and form labels bound to their inputs. Running the interface: walk the keyboard path in order, read computed names and roles from the accessibility tree, confirm a visible focus indicator at every stop and run the platform's automated audit. Each platform file's checklist and verification section names the patterns and tools. Report every check you could not run as `Not verified`.

**Format.** Group findings under the principle each violates, ordered by severity, one row per root cause listing every location it appears in:

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |

`Location` is `path/to/file:line`. `Why` names the WCAG criterion or principle and the user impact.

End with `Block` when any `HIGH` remains, `Approve` otherwise, leaving the rest in the table as work to do. Never `Approve` coverage you did not inspect. With nothing to report, state "No actionable accessibility findings" and report verification.

## References

| File | Read when |
| --- | --- |
| [focus-and-keyboard.md](focus-and-keyboard.md) | Focus indicators, focus not obscured, bypass blocks, focus order and composite widgets, focus trapping and restoration, key maps, view changes |
| [screen-readers.md](screen-readers.md) | Visually hidden content, choosing how to announce a change, live regions, hiding from assistive tech, alt text, video and audio |
| [forms.md](forms.md) | Labels, error messaging, autofill content types and keyboard types, submit behavior |
| [hit-areas.md](hit-areas.md) | Target sizes and exceptions, expanding a hit area, collisions, decorative layers, drag and gesture alternatives |
| [motion-and-zoom.md](motion-and-zoom.md) | Reduced motion (what to disable vs reduce), autoplay and timed UI, 200% text resize and 320 pt reflow |

Platform implementation, each with a pre-finish pattern checklist: [web](../../platforms/web/accessibility.md) (element choice and ARIA in [semantics-and-aria.md](../../platforms/web/semantics-and-aria.md)) · [Apple](../../platforms/apple/accessibility.md) · [Android](../../platforms/android/accessibility.md)
