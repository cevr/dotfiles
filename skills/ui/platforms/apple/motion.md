# Apple motion

How the [motion](../../references/motion/index.md) rules are built in SwiftUI, with UIKit and AppKit where the project uses them. Curves, durations, springs and [pattern values](../../references/motion/index.md#pattern-values) come from the neutral files; this file gives the API for each and says where Apple's convention wins. APIs were checked against the SwiftUI, UIKit and AppKit interfaces in the macOS 27 SDK.

## Where Apple's convention wins

| Convention | Wins over |
| --- | --- |
| System presentations and navigation (`sheet`, `popover`, `Menu`, `alert`, `confirmationDialog`, `NavigationStack` push, `TabView`) carry their own motion, gestures and Reduce Motion handling. Leave them unanimated. | The neutral modal, drawer and popover values |
| A sheet's drag, velocity and rubber-banding come from `.presentationDetents`; build a custom drawer only where a sheet can't express the design. | The neutral drag-to-dismiss build |
| System button styles (`.bordered`, `.borderedProminent`, list rows) keep their own pressed treatment. The `0.96` press scale is for a custom `ButtonStyle`. | [Buttons press to 0.96](../../references/motion/index.md#buttons-press-to-096) |
| SF Symbols swap with `.contentTransition(.symbolEffect(.replace))`. | The neutral icon cross-fade, for symbols |
| Since iOS 17 and macOS 14, `Animation.default` is `.spring(response: 0.55, dampingFraction: 1.0)` (before: `.easeInOut`). Apple's named springs, where a project already uses them, are its motion language. | The neutral default spring, in such a project |
| watchOS: WatchKit layout and appearance animations ease in and out with a built-in curve that can't be changed. visionOS: the HIG adds rules for motion at the edge of the field of view and for moving large objects. | The neutral curves on watchOS |

## Rule to API

| Neutral rule | SwiftUI | UIKit / AppKit |
| --- | --- | --- |
| Retargeting state transition | `withAnimation(.spring(duration: 0.4)) { state = … }`, or `.animation(_:value:)` scoped to one value | `UIViewPropertyAnimator`; `UIView.animate` with `.beginFromCurrentState`; AppKit `NSAnimationContext.runAnimationGroup` |
| Enter and exit | `.transition(…)` on a view inside an `if`; `.asymmetric(insertion:removal:)` for a shorter, smaller exit | |
| Strong and icon curves | `.timingCurve(0.23, 1, 0.32, 1, duration: 0.2)` | `UICubicTimingParameters(controlPoint1:controlPoint2:)`, `CAMediaTimingFunction(controlPoints:)` |
| Keyword curves | `.timingCurve(0, 0, 0.58, 1, duration:)` (ease-out), `.timingCurve(0.25, 0.1, 0.25, 1, duration:)` (ease) | |
| Spring | `.spring(duration: d, bounce: b)` ([conversion](../../references/motion/index.md#7-springs)) | `UIView.animate(springDuration:bounce:initialSpringVelocity:…)`, `UISpringTimingParameters(duration:bounce:initialVelocity:)` (iOS 17) |
| Fixed timeline, run once | `keyframeAnimator`, `phaseAnimator`: one-shot sequences only | `CAKeyframeAnimation` |
| Scale anchored at the trigger | `.scaleEffect(s, anchor: .top)`; `.transition(.scale(0.95, anchor: .topLeading).combined(with: .opacity))` | `layer.anchorPoint` |
| Move by own size | `.transition(.move(edge: .bottom))`, `.push(from: .trailing)` | |
| Render-only properties | `.offset`, `.scaleEffect`, `.rotationEffect`, `.opacity`, `.blur(radius:)`, `.visualEffect { }` | `transform`, `alpha` |
| Clip reveal | `.mask(alignment: .leading) { Rectangle().scaleEffect(x: progress, anchor: .leading) }` | `CALayer.mask` |
| Skip first-appearance animation | Nothing to add: SwiftUI animates value changes, so the initial state renders still. Start no state-swap animation in `onAppear`. | |
| Theme switch suppression | A color-scheme change animates only when its transaction carries an animation; scope every `.animation` with `value:`, or set `transaction.disablesAnimations` | |
| Stagger | `.animation(.timingCurve(0.23, 1, 0.32, 1, duration: 0.3).delay(Double(index) * 0.05), value: isShown)` | |
| Haptics on the same frame | `.sensoryFeedback(.success, trigger: value)`, `.impact(weight:intensity:)` | `UIImpactFeedbackGenerator` |
| Hover gating | Built in: `.hoverEffect` and `.onHover` fire only for a pointer (iPadOS, macOS) or gaze (visionOS) | |

## Springs

`.spring(duration:bounce:)` is the neutral spring exactly: its damping ratio is `1 − bounce` and its stiffness `(2π / duration)²`, verified by constructing `Spring(duration: 0.4, bounce: 0.2)` (ratio `0.8`, stiffness `246.7`).

| Neutral spring | SwiftUI |
| --- | --- |
| Default | `.spring(duration: 0.4)` (same as `.smooth(duration: 0.4)`) |
| Momentum release | `.spring(duration: 0.4, bounce: 0.2)` |
| Icon cross-fade | `.spring(duration: 0.3)` |
| Apple's drawer / sheet | `.spring(response: 0.3, dampingFraction: 0.8)` = `.spring(duration: 0.3, bounce: 0.2)` |

The named springs: `.smooth` is duration `0.5`, bounce `0`; `.snappy` `0.5`, `0.15`; `.bouncy` `0.5`, `0.3`; `.interactiveSpring` `0.15`, `0.15`, with a `0.25` blend.

## Patterns

The [pattern values](../../references/motion/index.md#pattern-values) in SwiftUI. Press feedback as a custom button style:

```swift
struct PressScaleStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(isEnabled && configuration.isPressed ? 0.96 : 1)
            .animation(.timingCurve(0, 0, 0.58, 1, duration: 0.15), value: configuration.isPressed)
    }
}
```

A custom popover-like surface, anchored at its trigger, with the reduced-motion fallback:

```swift
@Environment(\.accessibilityReduceMotion) private var reduceMotion

panel.transition(reduceMotion
    ? .opacity
    : .scale(0.95, anchor: .topLeading).combined(with: .opacity))
// shown with: withAnimation(.timingCurve(0.23, 1, 0.32, 1, duration: 0.2)) { isOpen.toggle() }
```

- **Icon cross-fade** (non-symbol icons): both icons in a `ZStack`, each with `.scaleEffect(on ? 1 : 0.25)`, `.opacity(on ? 1 : 0)`, `.blur(radius: on ? 0 : 4)`, animated with `.spring(duration: 0.3)`.
- **Staged entrance**: per chunk, `.opacity`, `.blur(radius: 4 → 0)` and `.offset(y: 12 → 0)` with `.easeOut(duration: 0.3).delay(0.1 * index)`, started from a state change rather than a timer.
- **Hold to confirm**: drive the clip `progress` with `withAnimation(.linear(duration: 2))` while `onLongPressGesture(minimumDuration: 2, perform:onPressingChanged:)` reports pressing, and back with the strong ease-out at `0.2` on release.
- **Tooltip**: `.help("…")` on macOS and iPadOS pointer is the system tooltip; its delay and motion are the system's.

## Reduced motion

| Setting | SwiftUI | UIKit / AppKit |
| --- | --- | --- |
| Reduce Motion | `@Environment(\.accessibilityReduceMotion)` | `UIAccessibility.isReduceMotionEnabled` and `reduceMotionStatusDidChangeNotification`; `UIAccessibility.prefersCrossFadeTransitions` (iOS 14); AppKit `NSWorkspace.shared.accessibilityDisplayShouldReduceMotion` |
| Reduce Transparency | `@Environment(\.accessibilityReduceTransparency)` | `UIAccessibility.isReduceTransparencyEnabled`; `NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency` |
| Increase Contrast | `@Environment(\.colorSchemeContrast) == .increased` | |

Custom `withAnimation` and `.transition` code runs unchanged under Reduce Motion; branch it on the setting as in the popover above. System presentations adapt on their own; under Reduce Transparency system materials turn opaque and `.glassEffect()` nearly so, while a custom translucent surface stays translucent and needs its own branch.

## Gestures

The [gesture rules](../../references/motion/gestures.md) with `DragGesture`:

- **Hysteresis**: `DragGesture` defaults to `minimumDistance: 10`, the neutral ~10pt.
- **1:1 tracking**: write `value.translation` into an `@State` offset applied with `.offset`, so the drag never touches layout.
- **Velocity**: `value.velocity` is in points per second. `value.predictedEndTranslation` is the system's own momentum projection; choose the snap target nearest to it, or apply the neutral `project` with `UIScrollView.DecelerationRate.normal.rawValue` (`0.998`; `.fast` is `0.99`).
- **Velocity handoff**: since iOS 17 a gesture's `onChanged` tracks velocity (`Transaction.tracksVelocity`), and a spring started in `onEnded` begins at that velocity, so `withAnimation(.spring(duration: 0.4, bounce: 0.2))` hands off with no extra code. Before iOS 17, pass a relative velocity to `.interpolatingSpring(stiffness:damping:initialVelocity:)`.
- **Snapping scroll**: `.scrollTargetBehavior(.paging)` or `.viewAligned` with `.scrollTargetLayout()`; the system projects and decelerates.
- **UIKit**: `UIPanGestureRecognizer.velocity(in:)` (points per second); `UIViewPropertyAnimator` to scrub and reverse an animation mid-flight; `UISpringTimingParameters(dampingRatio:initialVelocity:)` takes the relative velocity vector.

```swift
func rubberband(_ overshoot: CGFloat, dimension: CGFloat, c: CGFloat = 0.55) -> CGFloat {
    (overshoot * dimension * c) / (dimension + c * abs(overshoot))
}

DragGesture()
    .onChanged { offset = max(0, $0.translation.height) }     // past the top edge: rubberband instead
    .onEnded { value in
        let flick = value.velocity.height / 1000 > 0.11         // pt/ms
        withAnimation(.spring(duration: 0.4, bounce: 0.2)) {
            offset = (flick || value.predictedEndTranslation.height > height / 2) ? height : 0
        }
    }
```

Materials: `.background(.regularMaterial)` and its thinner and thicker siblings; on iOS 26 and later, `.glassEffect()` for custom Liquid Glass surfaces.

## Performance

- **Render-only modifiers** (`.offset`, `.scaleEffect`, `.rotationEffect`, `.opacity`, `.visualEffect`) change how a view draws, not its frame. `.frame`, `.padding` and alignment changes re-run layout every frame.
- **Per-frame values**: animate with `withAnimation` or drive frames with `TimelineView(.animation)`, never with a `Timer` writing `@State`, which re-evaluates `body` on every tick. Keep a continuously animating view in a small leaf view.
- **Where it runs**: UIKit and Core Animation animations, once committed, are rendered by the system's render server, so a busy main thread doesn't stall them. SwiftUI hands simple `.offset`, `.scaleEffect` and `.frame` animations to Core Animation too; they ran through a 3s main-thread block (iOS 27). An animation that needs per-frame app code, such as a custom `Animatable` shape, stalls with the main thread, and so does the rest of its transaction.
- **Shadows**: an animated `.shadow` re-renders every frame; in UIKit set `layer.shadowPath` so the shadow skips the offscreen pass.
- **Rasterization hint, last**: `.drawingGroup()` flattens complex vector content into one offscreen render, the counterpart of the web's `will-change`; add it only once a recording shows the cost. `.geometryGroup()` (iOS 17) stops a parent's animated geometry from desyncing its children.
- **Record**: Instruments' Animation Hitches and SwiftUI templates; `CADisplayLink` is the display-synced clock for hand-rolled per-frame work.

## Debugging

- **Slow motion**: the Simulator's Debug ▸ Slow Animations, or a temporary `.speed(0.2)` on the `Animation`.
- **Frame by frame**: record with Instruments and step through the hitches.
- **Real devices**: animation feel, flicks and rubber-banding need a device; the Simulator drops frames a phone would not.

## Detection rows

The [detection checklist](../../references/motion/standards.md#detection-checklist) rows as they appear in Swift code.

| Detection | Fix |
| --- | --- |
| `.transition(.scale)` (it starts at scale `1e-5`, effectively `0`) | `.scale(0.95, anchor:)` combined with `.opacity` |
| `withAnimation` or `.transition` that moves, scales or blurs with no `accessibilityReduceMotion` branch | Branch to `.opacity` under Reduce Motion |
| `.animation(_:)` with no `value:` | `.animation(_:value:)` scoped to the value that should animate |
| `.easeIn` on any UI | The strong ease-out `.timingCurve(0.23, 1, 0.32, 1, duration:)` |
| `.easeOut` or `.easeInOut` on a custom panel's open/close or on-screen movement | The strong curves, or a `0`-bounce spring |
| `bounce:` above `0`, `.bouncy` or `.snappy` outside a momentum release | `.spring(duration: 0.4)` |
| Press `scaleEffect` other than `0.96`, or one that ignores `isEnabled` | `0.96`, gated on `isEnabled` |
| Animated `.frame(width:height:)`, `.padding` or layout alignment | `.scaleEffect` / `.offset` |
| `Timer` or `onReceive(timer)` writing `@State` every frame | `withAnimation` or `TimelineView(.animation)` |
| Animated `.blur(radius:)` above `20` | Under `20`; `2`–`5` for a crossfade |
| `keyframeAnimator` / `phaseAnimator` driving a toggled, interactive state | A spring via `withAnimation` |
| Custom transitions or timing added to `sheet`, `NavigationStack` or `Menu` | The system's motion |
| A custom drag-to-dismiss where `.sheet` with `.presentationDetents` fits | The system sheet |
| `onEnded` snapping from the release point with no `velocity` or `predictedEndTranslation` | Project, then snap with velocity handoff |
| `withAnimation` in `onAppear` on a state swap | Let the initial state render still |
