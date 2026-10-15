# Accessibility on Android

Jetpack Compose implementation of [accessibility](../../references/accessibility/index.md), with View-system equivalents where they differ. The rules, criteria and reasons live there; this file maps each one to the API and names where Material or Android replace a value. Material 3 components (`Button`, `IconButton`, `Checkbox`, `Switch`, `TextField`, `AlertDialog`, `ModalBottomSheet`, `Snackbar`) carry role, state, touch target and focus for free; everything below is for what you build yourself.

## Platform values that win

| Neutral value | Android value | Notes |
| --- | --- | --- |
| [Target size](../../references/accessibility/hit-areas.md#target-sizes), web 44/40 heuristic | 48×48 dp | Material's minimum; Material components reserve it when interactive. |
| [200% text resize](../../references/accessibility/motion-and-zoom.md#zoom-and-reflow) | Font scale up to 200% (Android 14+), applied non-linearly | Large text grows less than small text, so `sp` values stop adding up: 4sp + 20sp may not equal 24sp. |
| [Escape closes](../../references/accessibility/focus-and-keyboard.md#keyboard-patterns) | Back (system back gesture, TalkBack's back gesture, a keyboard's Escape) | Material dialogs and sheets dismiss on Back. Escape is not Back: Compose `Dialog` and `AlertDialog` dismiss on it, but `ModalBottomSheet` (Material 3 1.4) and `BackHandler` ignore it. |
| [Reduced motion](../../references/accessibility/motion-and-zoom.md#reduced-motion) | "Remove animations", which sets the animator duration scale to 0 | There is no separate reduce-motion flag. |
| [Timed messages](../../references/accessibility/motion-and-zoom.md#autoplay-and-timed-ui) | The user's "Time to take action" setting | `SnackbarHost` stretches Short (4 s) and Long (10 s) through `AccessibilityManager.calculateRecommendedTimeoutMillis`. |

## Semantics

Rule: [native controls first](../../references/accessibility/index.md#native-controls-first) and [accessible names](../../references/accessibility/index.md#accessible-names).

| Need | Compose |
| --- | --- |
| Name | Visible `Text` first; `Icon(…, contentDescription = stringResource(R.string.share))` inside an `IconButton` for icon-only |
| Label in Name for Voice Access | A `contentDescription` that differs from visible text starts with that text; it replaces the text TalkBack would read |
| Action label | `Modifier.clickable(onClickLabel = "Open article") { … }`, `combinedClickable(onLongClickLabel = …)`; TalkBack says "Double tap to open article" |
| Role | `toggleable(…, role = Role.Checkbox)`, `selectable(…, role = Role.RadioButton)`, or `Modifier.semantics { role = Role.Button }` |
| State | `stateDescription = if (on) "Subscribed" else "Not subscribed"`; `selected`, `toggleableState` come from `selectable`/`toggleable` |
| Grouping | `clickable`/`toggleable` merge their children; `Modifier.semantics(mergeDescendants = true) {}` for a non-clickable row; `clearAndSetSemantics { contentDescription = … }` replaces the children |
| Headings | `Modifier.semantics { heading() }` |
| Window or pane title | `Activity.setTitle`, `Modifier.semantics { paneTitle = "Share sheet" }` on a pane that appears |
| Disabled | `enabled = false` sets `disabled()`: the node stays in the accessibility tree with `isEnabled = false`, so the reason can sit beside it |
| Custom actions | `customActions = listOf(CustomAccessibilityAction("Archive") { archive(); true })` |
| Collections | `LazyColumn` and `LazyRow` expose `collectionInfo`; a custom list sets `collectionInfo` and `collectionItemInfo` |

Use `clickable` for anything that acts, not `pointerInput { detectTapGestures }`, which carries no role, no focus and no TalkBack action.

## Focus and keyboard

Rule: [focus and keyboard](../../references/accessibility/focus-and-keyboard.md). Keyboard, D-pad and Switch Access users move by focus; arrow keys move in 2D automatically.

| Rule | API |
| --- | --- |
| [Visible indicator](../../references/accessibility/focus-and-keyboard.md#focus-rings) | Material components and `clickable` show a focused state layer. Custom: `Modifier.onFocusChanged { focused = it.isFocused }`, then draw a border in the project's focus token |
| Keyboard-reachable custom view | `Modifier.focusable()` (`clickable` already includes it); keys with `onKeyEvent` / `onPreviewKeyEvent` |
| Field-to-field order | `KeyboardOptions(imeAction = ImeAction.Next)`; state-based text fields move on Next, value-based ones need `KeyboardActions(onNext = { focusManager.moveFocus(FocusDirection.Down) })` |
| Initial or programmatic focus | `val requester = remember { FocusRequester() }`, `Modifier.focusRequester(requester)`, `LaunchedEffect(Unit) { requester.requestFocus() }` |
| [One stop per composite widget](../../references/accessibility/focus-and-keyboard.md#focus-order) | `Modifier.focusGroup()`; `Modifier.focusRestorer()` returns focus to the last-focused child |
| [Focus order](../../references/accessibility/focus-and-keyboard.md#focus-order) | Layout order. Screen-reader order: `isTraversalGroup = true` on the container, `traversalIndex` (lower first, default `0f`) on focusable children. Keyboard order: `focusProperties { next = …; previous = … }`. Both are for layouts whose visual order can't follow composition order |
| [Focus not obscured](../../references/accessibility/focus-and-keyboard.md#focus-not-obscured) | Put sticky bars in `Scaffold`'s `topBar`/`bottomBar` and pass `innerPadding` as `contentPadding` to the scrolling list, so focused items scroll clear of them |

### Overlays and view changes

Rule: [focus trapping and restoration](../../references/accessibility/focus-and-keyboard.md#focus-trapping-and-restoration). `Dialog`, `AlertDialog`, `ModalBottomSheet` and `Popup` are separate windows: focus moves in, the background is unreachable, Back dismisses. A custom in-window overlay rebuilds that: `paneTitle` on the overlay, a `FocusRequester` to move in, `BackHandler { dismiss() }`, and `Modifier.semantics { hideFromAccessibility() }` plus `focusProperties { canFocus = false }` on the background while it shows. Prefer the window components.

Restore focus to the trigger on close with its `FocusRequester` or `focusRestorer()`. On a navigation change, give each destination a `paneTitle` (or set the activity title) so TalkBack announces it, and request focus on the new screen's heading.

## Forms

Rule: [forms](../../references/accessibility/forms.md).

| Rule | API |
| --- | --- |
| [Label](../../references/accessibility/forms.md#labels) | `OutlinedTextField(label = { Text("Email") })`; `placeholder` is not the label |
| Checkbox and text share a target | `Row(Modifier.toggleable(value = checked, role = Role.Checkbox, onValueChange = { … })) { Checkbox(checked, onCheckedChange = null); Text("Send me updates") }` |
| [Error](../../references/accessibility/forms.md#error-messaging) | `isError = true` and `supportingText = { Text(error) }`. Material sets a generic error description ("Invalid input"); pass the real message with `Modifier.semantics { error(message) }` on the field; it replaces the default in `AccessibilityNodeInfo.error`. Focus the first invalid field with its `FocusRequester` |
| Content type | `Modifier.semantics { contentType = ContentType.EmailAddress }`: `Username`, `Password`, `NewUsername`, `NewPassword`, `PersonFullName`, `PhoneNumber`, `PostalAddress`, `PostalCode`, `CreditCardNumber`, `CreditCardExpirationDate`, `CreditCardSecurityCode`, `SmsOtpCode`; combine with `+` |
| Keyboard | `KeyboardOptions(keyboardType = KeyboardType.Email)`; `Uri`, `Phone`, `NumberPassword` (PINs, codes), `Decimal` (money), `Number` (quantities) |
| Spelling and case | `KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false)` |
| Return key | `imeAction = ImeAction.Send`, `Search`, `Done`, `Next` |

Views: `android:autofillHints`, `android:inputType`, `android:imeOptions`, and `TextView.setError`, which manages the error semantics and event itself.

## Screen readers

Rule: [screen readers](../../references/accessibility/screen-readers.md). `View.announceForAccessibility` is deprecated since API 36, and services may ignore it; describe the change semantically instead.

| Rule | API |
| --- | --- |
| [Polite or assertive update](../../references/accessibility/screen-readers.md#live-regions) | `Modifier.semantics { liveRegion = LiveRegionMode.Polite }` (or `Assertive`) on a node that stays composed while its text changes. Views: `setAccessibilityLiveRegion` |
| Toasts | `SnackbarHost` sets its own live region and pane title; use `Snackbar`, not a hand-built banner |
| State change | `stateDescription`, announced when it changes |
| Field error | `error(message)`, read with the field |
| [Visually hidden content](../../references/accessibility/screen-readers.md#visually-hidden-content) | No off-screen text: put the context in `contentDescription` or `stateDescription` on the merged parent |
| [Hide from assistive tech](../../references/accessibility/screen-readers.md#hiding-from-assistive-tech) | `contentDescription = null` on decorative `Image`/`Icon`; `Modifier.semantics { hideFromAccessibility() }` (replaces `invisibleToUser()`) or `clearAndSetSemantics {}` on a decorative subtree |
| [Alt text](../../references/accessibility/screen-readers.md#alt-text) | `Image(painter, contentDescription = "Ticket QR code")`, from a string resource |
| Loading | `CircularProgressIndicator` exposes progress semantics; a custom one sets `progressBarRangeInfo` (`ProgressBarRangeInfo.Indeterminate` while unknown) |

## Hit areas

Rule: [hit areas](../../references/accessibility/hit-areas.md). 48×48 dp wins on Android.

- Material components add the padding when they are interactive: a `Checkbox` with `onCheckedChange = null` drops it, because its parent row is the target.
- A custom control takes `Modifier.minimumInteractiveComponentSize()`, which reserves `LocalMinimumInteractiveComponentSize` (48 dp) around a smaller drawn size.
- Compose also extends a small `clickable`'s touch area past its bounds, which can overlap a neighbor's; give it a real minimum with `sizeIn(minWidth = 48.dp, minHeight = 48.dp)` to [avoid the collision](../../references/accessibility/hit-areas.md#collision-rule).
- Decorative layers pass touches through unless they carry `clickable` or `pointerInput`; keep scrims that dismiss as `clickable` with an `onClickLabel`.
- A swipe or drag needs [a single-pointer alternative](../../references/accessibility/hit-areas.md#gestures-and-dragging): a visible button, or `customActions` (for `SwipeToDismissBox`, a "Delete" action).

## Motion and zoom

Rule: [motion and zoom](../../references/accessibility/motion-and-zoom.md).

- Compose animations follow the animator duration scale (since Compose Animation 1.2): at 0 they finish on the next frame. That removes the motion but not the layout change, so a slide still jumps. To swap slides for fades, read the setting:

```kotlin
val reduceMotion = Settings.Global.getFloat(
    context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f
) == 0f
val enter = if (reduceMotion) fadeIn() else slideInVertically() + fadeIn()
```

- Gate hand-driven animations (frame loops, Lottie) on the same flag. `rememberInfiniteTransition` stops on its own at scale 0, holding its end values.
- Text in `sp`, including line height; never `sp` for padding or fixed heights. Convert with `TypedValue.applyDimension` / `deriveDimension`; `fontScale` is informational now that scaling is non-linear.
- Reflow at large font scale with `FlowRow`, a row-to-column switch, or wrapping text; never a fixed height on a text container.
- Contrast: the system contrast setting (`UiModeManager.getContrast()`, API 34) and medium/high-contrast color schemes belong to [color](../../references/color/index.md).
- Snackbars with an action use `SnackbarDuration.Indefinite` with `withDismissAction = true`.

## Before you finish

| Pattern | Fix |
| --- | --- |
| `Icon`/`Image` with a meaningful graphic and `contentDescription = null` | Describe it from a string resource |
| `pointerInput { detectTapGestures` on something that acts | `clickable` with `onClickLabel` |
| `Modifier.size(24.dp).clickable` on a custom control | `minimumInteractiveComponentSize()` or `sizeIn(minWidth = 48.dp, minHeight = 48.dp)` |
| `contentDescription` that omits the visible text | Start with the visible text |
| `announceForAccessibility` | `liveRegion`, `paneTitle`, `stateDescription` or `error()` |
| `isError = true` with no `semantics { error(…) }` | Pass the real message |
| Text sizes in `dp`, or `sp` used for padding | `sp` for text and line height, `dp` for space |
| `Modifier.height(…)` on a text container | `heightIn(min = …)` |
| Slide, scale or infinite animation with no duration-scale check | Fade, or stop, under Remove animations |
| `SnackbarDuration.Short` on a snackbar with an action | `Indefinite` with a dismiss action |
| A custom overlay `Box` acting as a dialog | `Dialog`/`ModalBottomSheet`, or pane title, focus and background hiding |
| `SwipeToDismissBox` or drag with no other path | `customActions` or a visible button |

## Verify

Run Accessibility Scanner on each screen. In Compose UI tests (Compose 1.8+), add `ui-test-junit4-accessibility`, call `composeTestRule.enableAccessibilityChecks()` and trigger `onRoot().tryPerformAccessibilityChecks()`; it flags missing labels, contrast, small targets and traversal order. Assert semantics with matchers such as `onNodeWithContentDescription("Share")`, `assertHasClickAction()` and `SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Switch)`; dump the tree with `onRoot(useUnmergedTree = true).printToLog("a11y")`. On a device: TalkBack through every flow, Switch Access, a hardware keyboard (Tab, arrows, Enter, Escape), the largest font size, and Remove animations.
