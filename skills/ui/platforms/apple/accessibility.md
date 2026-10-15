# Accessibility on Apple platforms

SwiftUI implementation of [accessibility](../../references/accessibility/index.md), with UIKit equivalents where they differ. The rules, criteria and reasons live there; this file maps each one to the API and names where the Human Interface Guidelines replace a value. Standard controls (`Button`, `Toggle`, `Picker`, `Link`, `NavigationLink`, `TextField`, `sheet`, `alert`) carry role, name, state, focus and Dynamic Type for free; everything below is for what you build yourself.

## Platform values that win

| Neutral value | Apple value | Notes |
| --- | --- | --- |
| [Target size](../../references/accessibility/hit-areas.md#target-sizes), web 44/40 heuristic | 44×44 pt on iOS, iPadOS and watchOS; 28×28 pt on macOS; 60×60 pt on visionOS | HIG default control sizes. The HIG minimums (28 pt iOS, 20 pt macOS) sit above WCAG's 24 pt only on iOS; build to the default. |
| [200% text resize](../../references/accessibility/motion-and-zoom.md#zoom-and-reflow) | Dynamic Type, through the accessibility sizes | HIG: at least 200% (140% on watchOS). |
| [Escape closes](../../references/accessibility/focus-and-keyboard.md#keyboard-patterns) | Escape on a keyboard; the two-finger scrub gesture in VoiceOver | Both reach `.accessibilityAction(.escape)`; system sheets handle them. |

## Semantics

Rule: [native controls first](../../references/accessibility/index.md#native-controls-first) and [accessible names](../../references/accessibility/index.md#accessible-names).

| Need | SwiftUI |
| --- | --- |
| Name | Visible text first: `Button("Delete")`, `Label("Delete", systemImage: "trash")`. Icon-only: `Label` with `.labelStyle(.iconOnly)` keeps the text as the name, or `.accessibilityLabel("Delete")` |
| Label in Name for Voice Control | The label starts with the visible text; add spoken alternatives with `.accessibilityInputLabels([Text("Send"), Text("Submit")])` |
| State and value | `.accessibilityValue(_:)` for a value; `.accessibilityAddTraits(.isSelected)`, `.isToggle`, `.isButton`, `.isLink`, `.isHeader` for role and state |
| Hint | `.accessibilityHint(_:)` only when the result of activating isn't obvious from the name |
| Custom control | `.accessibilityRepresentation { Toggle(…) }` gives a custom view a standard control's semantics; `.accessibilityAdjustableAction` for a value VoiceOver swipes up and down |
| Grouping | `.accessibilityElement(children: .combine)` merges a row into one element; `.contain` keeps children but groups them; `.ignore` replaces them with your own label |
| Headings | `.accessibilityAddTraits(.isHeader)`; `.accessibilityHeading(.h2)` for levels |
| Window or screen title | `.navigationTitle(_:)`; on macOS the window title follows it |
| Disabled | `.disabled(true)`: VoiceOver still reaches the control and reads it as dimmed, so the reason can sit in its hint or beside it (unverified wording) |
| Custom navigation | `.accessibilityRotor(_:entries:)` for a list of landmarks, errors or matches |

Avoid `.onTapGesture` for anything that acts: it carries no button trait, no keyboard activation and no Voice Control name. Use `Button` with a custom `ButtonStyle`.

## Focus and keyboard

Rule: [focus and keyboard](../../references/accessibility/focus-and-keyboard.md). Keyboard users reach iOS and iPadOS through Full Keyboard Access and macOS through Keyboard Navigation; switch users through Switch Control.

| Rule | API |
| --- | --- |
| [Visible indicator](../../references/accessibility/focus-and-keyboard.md#focus-rings) | The system draws it (the macOS focus ring, the Full Keyboard Access highlight). `.focusEffectDisabled()` removes it; pair it with a replacement driven by `@Environment(\.isFocused)` |
| Keyboard-reachable custom view | `.focusable()`, then handle keys with `.onKeyPress(_:action:)` |
| Field-to-field order | `@FocusState` + `.focused($field, equals: .email)`; `.onSubmit { field = .password }` with `.submitLabel(.next)` |
| Initial focus | `.defaultFocus($field, .email)` |
| Shortcuts | `.keyboardShortcut(_:modifiers:)`; `.keyboardShortcut(.defaultAction)` and `.cancelAction` on dialog buttons; never override system shortcuts |
| [One stop per composite widget](../../references/accessibility/focus-and-keyboard.md#focus-order) | `.focusSection()` (macOS, tvOS) groups a region for directional moves |
| [Focus order](../../references/accessibility/focus-and-keyboard.md#focus-order) | Declaration order is VoiceOver and keyboard order; `.accessibilitySortPriority(_:)` (higher reads first) only where layout can't follow it |
| Escape | `.onExitCommand` (macOS); `.accessibilityAction(.escape) { dismiss() }` for VoiceOver on a custom overlay |
| [Focus not obscured](../../references/accessibility/focus-and-keyboard.md#focus-not-obscured) | Put sticky chrome in `.safeAreaInset(edge:)` or a toolbar, not a `ZStack` overlay, so the scroll view's insets include it |

### Overlays and view changes

Rule: [focus trapping and restoration](../../references/accessibility/focus-and-keyboard.md#focus-trapping-and-restoration). `sheet`, `fullScreenCover`, `popover`, `alert` and `confirmationDialog` contain VoiceOver and keyboard focus and restore it on dismissal. A custom overlay rebuilds that:

```swift
@AccessibilityFocusState private var overlayFocused: Bool

CustomOverlay()
    .accessibilityAddTraits(.isModal)          // VoiceOver ignores what's behind
    .accessibilityFocused($overlayFocused)     // move VoiceOver focus in
    .accessibilityAction(.escape) { isPresented = false }
    .onAppear { overlayFocused = true }
```

Return focus to the trigger on close with a second `@AccessibilityFocusState` (and `@FocusState` for the keyboard). UIKit: `accessibilityViewIsModal = true` on the overlay. `NavigationStack` pushes move VoiceOver to the new screen; after a custom view swap, post `AccessibilityNotification.ScreenChanged(nil).post()` or move `@AccessibilityFocusState` to the new heading.

## Forms

Rule: [forms](../../references/accessibility/forms.md).

| Rule | API |
| --- | --- |
| [Label](../../references/accessibility/forms.md#labels) | `TextField(text:prompt:label:)`: the label is the name, the `prompt` is the placeholder. In a `Form`, `LabeledContent` or the field's title. `Toggle("Send me updates", isOn:)` shares one target |
| Content type (iOS) | `.textContentType(.emailAddress)`, `.username`, `.password`, `.newPassword`, `.oneTimeCode`, `.name`, `.telephoneNumber`, `.fullStreetAddress`, `.postalCode`, `.creditCardNumber`; `SecureField` for passwords. macOS takes `NSTextContentType` (`.username`, `.password`, `.oneTimeCode`) |
| Keyboard (iOS) | `.keyboardType(.emailAddress)`, `.URL`, `.phonePad`, `.numberPad` (codes, PINs), `.decimalPad` (money) |
| Spelling and case | `.textInputAutocapitalization(.never)`, `.autocorrectionDisabled()` |
| Return key | `.submitLabel(.send)`, `.search`, `.done`, `.next` |

[Errors](../../references/accessibility/forms.md#error-messaging): SwiftUI has no invalid trait. Render the error `Text` under the field, attach it to the field with `.accessibilityHint(error)` so VoiceOver reads it with the field (unverified as the best carrier; `.accessibilityCustomContent` is the alternative), and on submit move `@FocusState` and `@AccessibilityFocusState` to the first invalid field.

## Screen readers

Rule: [screen readers](../../references/accessibility/screen-readers.md).

| Rule | API |
| --- | --- |
| [Announcement](../../references/accessibility/screen-readers.md#choosing-how-to-announce-a-change) | `AccessibilityNotification.Announcement("Saved").post()` (iOS 17, macOS 14). There are no live regions; post once per change. For urgency, set `accessibilitySpeechAnnouncementPriority = .high` on an `AttributedString` announcement. UIKit: `UIAccessibility.post(notification: .announcement, argument:)` |
| Frequently updating value | `.accessibilityAddTraits(.updatesFrequently)` on a timer or meter, so VoiceOver polls rather than announcing each tick |
| [Visually hidden content](../../references/accessibility/screen-readers.md#visually-hidden-content) | There is no off-screen text. Add the context to the element: `.accessibilityLabel`, `.accessibilityHint`, or `.accessibilityCustomContent(_:_:)` for secondary details |
| [Hide from assistive tech](../../references/accessibility/screen-readers.md#hiding-from-assistive-tech) | `.accessibilityHidden(true)`; `Image(decorative: "flourish")`; SF Symbols beside text in a `Label` are already merged |
| [Alt text](../../references/accessibility/screen-readers.md#alt-text) | `Image("qr", label: Text("Ticket QR code"))`. An unlabeled `Image("hero_2x")` reads its asset name |
| Charts | Swift Charts exposes an audio graph; describe a custom chart with `.accessibilityChartDescriptor(_:)` |
| Video | `VideoPlayer` / `AVPlayerViewController` render captions and playback controls; honor `@Environment(\.accessibilityDimFlashingLights)` |

## Hit areas

Rule: [hit areas](../../references/accessibility/hit-areas.md). 44×44 pt wins on iOS (see the table above).

```swift
Button(action: markDone) {
    Image(systemName: "checkmark")
        .frame(width: 20, height: 20)          // drawn size
        .frame(minWidth: 44, minHeight: 44)     // target size
        .contentShape(Rectangle())              // transparent area hits too
}
.accessibilityLabel("Mark done")
```

`.contentShape` is what makes padding and transparent pixels hit-testable; without it only drawn pixels respond. A decorative layer over controls takes `.allowsHitTesting(false)` and `.accessibilityHidden(true)`. A drag or swipe needs [a single-pointer alternative](../../references/accessibility/hit-areas.md#gestures-and-dragging): a visible button, or `.accessibilityAction(named: "Move up") { … }`. `List` `.swipeActions` appear as VoiceOver actions (unverified on every OS version).

## Motion and zoom

Rule: [motion and zoom](../../references/accessibility/motion-and-zoom.md).

| Setting | Environment value | Response |
| --- | --- | --- |
| Reduce Motion | `\.accessibilityReduceMotion` | Swap slides, scales and springs for opacity; stop parallax and autoplay ([what to disable](../../references/accessibility/motion-and-zoom.md#what-to-disable-vs-reduce)) |
| Prefer Cross-Fade Transitions | `\.accessibilityPrefersCrossFadeTransitions` | Navigation-style transitions become fades |
| Animated images | `\.accessibilityPlayAnimatedImages` | Show the first frame when false |
| Reduce Transparency | `\.accessibilityReduceTransparency` | Replace materials and blur with opaque fills |
| Differentiate Without Color | `\.accessibilityDifferentiateWithoutColor` | Add the shape or icon cue even where the design relies on color |
| Increase Contrast | `\.colorSchemeContrast == .increased` | High-contrast asset colors; owned by [color](../../references/color/index.md) |
| Button Shapes | `\.accessibilityShowButtonShapes` | Borderless buttons get a visible shape |

```swift
@Environment(\.accessibilityReduceMotion) private var reduceMotion

.transition(reduceMotion ? .opacity : .move(edge: .bottom))
.animation(reduceMotion ? nil : .spring, value: isOpen)
```

UIKit: `UIAccessibility.isReduceMotionEnabled` and its change notification.

Text size ([zoom and reflow](../../references/accessibility/motion-and-zoom.md#zoom-and-reflow)): use text styles (`.font(.body)`), scale custom metrics with `@ScaledMetric`, and switch a row to a column when `dynamicTypeSize.isAccessibilitySize` (or let `ViewThatFits` choose). A tab bar or toolbar item that cannot grow takes `.accessibilityShowsLargeContentViewer()`. Cap growth with `.dynamicTypeSize(...DynamicTypeSize.accessibility2)` only on chrome that would otherwise break, never on content. UIKit: `UIFont.preferredFont(forTextStyle:)` with `adjustsFontForContentSizeCategory = true`. Type scales belong to [typography](../../references/typography/index.md).

## Before you finish

| Pattern | Fix |
| --- | --- |
| `Button { } label: { Image(systemName:) }` with no label | `Label(…).labelStyle(.iconOnly)` or `.accessibilityLabel` |
| `.onTapGesture` on a view that acts as a button | `Button` with a `ButtonStyle` |
| `Image("name")` in content with no `label:` and no `decorative:` | Describe it, or mark it decorative |
| `.accessibilityLabel` that omits the visible text | Start with the visible text; add `.accessibilityInputLabels` |
| `.accessibilityHidden(true)` on a container holding buttons | Hide only the decorative children |
| Tappable view framed under 44 pt with no `.contentShape` | Minimum frame plus `.contentShape(Rectangle())` |
| `.focusEffectDisabled()` with no `isFocused` styling | Restore the system ring or draw a verified one |
| `.transition(.move…)`, `.scale`, or a looping animation with no `accessibilityReduceMotion` read | Gate it |
| `.font(.system(size:))` on body text, `.lineLimit(1)` on text that grows | Text styles; let it wrap |
| A `ZStack` overlay acting as a modal | `sheet`/`fullScreenCover`, or `.isModal` plus focus handling |
| `DragGesture` or `.swipeActions` with no other path | A button or `.accessibilityAction(named:)` |

## Verify

Run the Accessibility Inspector audit (Xcode › Open Developer Tool) and, in UI tests, `try app.performAccessibilityAudit()`. On a device: VoiceOver through every flow, Voice Control with "Show names" to check Label in Name, Full Keyboard Access (iOS) or Keyboard Navigation (macOS) for the keyboard walk, and Switch Control on custom controls. Preview at `.environment(\.dynamicTypeSize, .accessibility5)` and with Xcode's Environment Overrides for Reduce Motion, Reduce Transparency and Increase Contrast.
