# Android motion

How the [motion](../../references/motion/index.md) rules are built in Jetpack Compose. Curves, durations, springs and [pattern values](../../references/motion/index.md#pattern-values) come from the neutral files; this file gives the Compose API for each and says where Material's convention wins. APIs were checked against androidx-main (Compose 1.14 alpha, material3 1.6 alpha) and the stable API files (foundation 1.12, material3 1.4 and 1.5 beta).

## Where Material's convention wins

| Convention | Wins over |
| --- | --- |
| Material 3 components (`ModalBottomSheet`, `DropdownMenu`, `Snackbar`, dialogs, `NavigationBar`, `TopAppBar` scroll behavior) carry their own motion and gestures. Leave them unanimated. | The neutral modal, drawer, popover and toast values |
| Material buttons, cards and list items give press feedback with a ripple and state layer, not a scale. The `0.96` press scale is for a custom pressable. | [Buttons press to 0.96](../../references/motion/index.md#buttons-press-to-096) |
| A project on `MaterialTheme.motionScheme` (material3 1.5 and later; absent from 1.4) uses its springs: `defaultSpatialSpec()` for position, size and scale, `defaultEffectsSpec()` for opacity and color, plus `fast…` and `slow…` variants. | The neutral springs, in such a project |
| Material's easing and duration tokens, where the project uses tween-based motion ([table](#material-tokens)). | The neutral curves and durations, in such a project |
| The system back gesture drives a surface's exit through predictive back; the surface follows the gesture's progress. | Neutral exit timing on back |
| Scrolling containers stretch at their edges (Android 12 and later `OverscrollEffect`). | Rubber-banding, inside scroll containers |
| Android has no "reduce motion" flag, only "Remove animations" ([reduced motion](#reduced-motion)). | "Gentler, not zero" when animations are removed |

### Material tokens

| `MotionScheme` spring | `standard()` damping / stiffness | `expressive()` damping / stiffness |
| --- | --- | --- |
| `defaultSpatialSpec` | `0.9` / `700` | `0.8` / `380` |
| `fastSpatialSpec` | `0.9` / `1400` | `0.6` / `800` |
| `slowSpatialSpec` | `0.9` / `300` | `0.8` / `200` |
| `default`/`fast`/`slowEffectsSpec` | `1.0` / `1600`, `3800`, `800` | same |

`MaterialTheme` defaults to `standard()`; `MaterialExpressiveTheme` to `expressive()`. Easing tokens (m3.material.io): emphasized `(0.2, 0, 0, 1)` in Compose (the spec is a two-segment path), emphasized decelerate `(0.05, 0.7, 0.1, 1)`, emphasized accelerate `(0.3, 0, 0.8, 0.15)`, standard `(0.2, 0, 0, 1)`, standard decelerate `(0, 0, 0, 1)`, standard accelerate `(0.3, 0, 1, 1)`. Durations: short 1–4 = `50`/`100`/`150`/`200ms`, medium 1–4 = `250`–`400ms`, long 1–4 = `450`–`600ms`, extra-long 1–4 = `700`–`1000ms`.

## Rule to API

| Neutral rule | Compose |
| --- | --- |
| Retargeting state transition | `animateFloatAsState`, `animateDpAsState`, `updateTransition`, `Animatable.animateTo`: all retarget from the current value and velocity |
| Enter and exit | `AnimatedVisibility(enter = …, exit = …)`, `AnimatedContent`; a shorter, smaller `exit` than `enter` |
| Strong and icon curves | `tween(200, easing = CubicBezierEasing(0.23f, 1f, 0.32f, 1f))` |
| Keyword curves | `EaseOut` is `(0, 0, 0.58, 1)` and `Ease` is `(0.25, 0.1, 0.25, 1)`, the neutral keyword curves. `FastOutSlowInEasing` is `(0.4, 0, 0.2, 1)`, a different curve. |
| Spring | `spring(dampingRatio = 1f - b, stiffness = (2π / d)²)` ([springs](#springs)) |
| Fixed timeline, run once | `keyframes { }`; loops with `rememberInfiniteTransition` |
| Scale anchored at the trigger | `scaleIn(initialScale = 0.95f, transformOrigin = TransformOrigin(0f, 0f))`; `graphicsLayer { transformOrigin = …; scaleX = s; scaleY = s }` |
| Move by own size | `slideInVertically { fullHeight -> fullHeight }`, `slideOutHorizontally { -it }` |
| Render-only properties | `Modifier.graphicsLayer { translationY; scaleX; scaleY; rotationZ; alpha }`, `Modifier.offset { IntOffset(…) }` |
| Clip reveal | `Modifier.drawWithContent { clipRect(right = size.width * progress) { this@drawWithContent.drawContent() } }` |
| Skip first-appearance animation | Nothing to add: `animate*AsState` and `AnimatedVisibility(visible = …)` start at their first value. To animate an entrance, `AnimatedVisibility(visibleState = remember { MutableTransitionState(false).apply { targetState = true } })`. |
| Theme switch suppression | `MaterialTheme` swaps colors instantly; only colors routed through `animateColorAsState` animate, so route none of the scheme through it |
| Stagger | Per item, `tween(300, delayMillis = index * 50, easing = …)` |
| Haptics on the same frame | `LocalHapticFeedback.current.performHapticFeedback(HapticFeedbackType.Confirm)`; `Reject`, `ToggleOn`, `ToggleOff`, `SegmentTick`, `GestureEnd` and others from Compose UI 1.8 |
| Hover gating | Built in: `Modifier.hoverable` and `collectIsHoveredAsState()` fire only for a mouse, trackpad or stylus |

## Springs

The neutral spring maps as `dampingRatio = 1 − bounce`, `stiffness = (2π / duration)²`; Compose springs have unit mass.

| Neutral spring | Compose |
| --- | --- |
| Default | `spring(dampingRatio = 1f, stiffness = 247f)` |
| Momentum release | `spring(dampingRatio = 0.8f, stiffness = 247f)` |
| Icon cross-fade | `spring(dampingRatio = 1f, stiffness = 439f)` |
| Apple's drawer / sheet | `spring(dampingRatio = 0.8f, stiffness = 439f)` |

`spring()` with no arguments, the default of every `animate*AsState`, is `dampingRatio = 1f, stiffness = Spring.StiffnessMedium` (`1500`, a duration near `0.16s`): pass the spec explicitly. The named stiffnesses: `StiffnessHigh` `10000`, `StiffnessMedium` `1500`, `StiffnessMediumLow` `400` (duration about `0.31`), `StiffnessLow` `200` (about `0.44`), `StiffnessVeryLow` `50`. Damping ratios: `DampingRatioNoBouncy` `1`, `LowBouncy` `0.75`, `MediumBouncy` `0.5`, `HighBouncy` `0.2`.

```kotlin
fun <T> neutralSpring(duration: Float, bounce: Float = 0f, visibilityThreshold: T? = null) =
    spring(dampingRatio = 1f - bounce, stiffness = (2f * PI.toFloat() / duration).pow(2), visibilityThreshold = visibilityThreshold)
```

## Patterns

The [pattern values](../../references/motion/index.md#pattern-values) in Compose. Press feedback on a custom pressable:

```kotlin
val interaction = remember { MutableInteractionSource() }
val pressed by interaction.collectIsPressedAsState()
val scale by animateFloatAsState(if (pressed && enabled) 0.96f else 1f, tween(150, easing = EaseOut), label = "press")
Box(Modifier.graphicsLayer { scaleX = scale; scaleY = scale }
    .clickable(interaction, indication = null, enabled = enabled) { onClick() })
```

A custom popover-like surface anchored at its top-start trigger, with the reduced-motion fallback:

```kotlin
val strongOut = CubicBezierEasing(0.23f, 1f, 0.32f, 1f)
AnimatedVisibility(
    visible = open,
    enter = fadeIn(tween(200, easing = strongOut)) +
        if (reduceMotion) EnterTransition.None else scaleIn(tween(200, easing = strongOut), 0.95f, TransformOrigin(0f, 0f)),
    exit = fadeOut(tween(150, easing = strongOut)) +
        if (reduceMotion) ExitTransition.None else scaleOut(tween(150, easing = strongOut), 0.95f, TransformOrigin(0f, 0f)),
) { Panel() }
```

- **Icon cross-fade**: `AnimatedContent(targetState = on, transitionSpec = { (fadeIn(s) + scaleIn(s, 0.25f)) togetherWith (fadeOut(s) + scaleOut(s, 0.25f)) })` with `s = spring(1f, 439f)`. `Modifier.blur` works only on Android 12 and later and is ignored below, so the blur part drops on older devices.
- **Staged entrance**: per chunk, `fadeIn` + `slideInVertically { 12.dp.roundToPx() }` with `tween(300, delayMillis = 100 * index, easing = EaseOut)`, driven from a `MutableTransitionState` so it plays on first composition.
- **Hold to confirm**: in `pointerInput`, `detectTapGestures(onPress = { … })` launches `progress.animateTo(1f, tween(2000, easing = LinearEasing))` and, after `tryAwaitRelease()`, `progress.animateTo(0f, tween(200, easing = strongOut))`.
- **Toast and drawer**: `Snackbar` and `ModalBottomSheet` (Material wins).

## Reduced motion

Android has no reduce-motion preference on phones (Wear OS has the experimental `LocalReduceMotion`). The accessibility setting "Remove animations" and the developer option "Animator duration scale" both set `Settings.Global.ANIMATOR_DURATION_SCALE`, and Compose wires it into every animation's `MotionDurationScale` automatically: at `0`, finite animations jump to their end on the next frame and infinite transitions skip to their end value.

So the platform's behavior replaces "gentler, not zero" when animations are removed: every state change lands instantly, which makes the static cue (color, icon, label) mandatory. To choose the fallback yourself (an opacity-only cross-fade at a non-zero scale, or no movement at a reduced one), read the scale and branch:

```kotlin
val context = LocalContext.current
val reduceMotion = remember {
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
}
```

`ValueAnimator.areAnimatorsEnabled()` (API 26) also returns false under Battery Saver; `ValueAnimator.getDurationScale()` and `registerDurationScaleChangeListener` (API 33) observe changes. There is no reduce-transparency setting; for increased contrast, `UiModeManager.getContrast()` (API 34; see [color](color.md)).

## Gestures

The [gesture rules](../../references/motion/gestures.md) in Compose:

- **Hysteresis**: the platform touch slop, `LocalViewConfiguration.current.touchSlop`, replaces the neutral ~10pt.
- **1:1 tracking and velocity**: `Modifier.draggable(rememberDraggableState { delta -> … }, Orientation.Vertical, onDragStopped = { velocity -> … })`, whose velocity is in px/s; or `pointerInput { detectDragGestures(…) }` feeding a `VelocityTracker` (`addPosition(timeMillis, position)`, `calculateVelocity()` in px/s). Apply the offset with `Modifier.offset { }` or `graphicsLayer { }`.
- **Velocity handoff**: `Animatable.animateTo(target, spring(0.8f, 247f), initialVelocity = velocity)`; the velocity is absolute, in the value's units per second. `animate*AsState` and `Animatable` keep velocity across a retarget on their own.
- **Projection**: `splineBasedDecay<Float>(density).calculateTargetValue(current, velocity)` is Android's own fling deceleration and replaces the neutral `project` for Android scroll feel; snap to the anchor nearest the result. `exponentialDecay()` is the simpler form.
- **Snapping between anchors**: `AnchoredDraggableState(initialValue, DraggableAnchors { Closed at 0f; Open at -height })` with `Modifier.anchoredDraggable(state, Orientation.Vertical, flingBehavior = AnchoredDraggableDefaults.flingBehavior(state, positionalThreshold = { it / 2f }, animationSpec = spring(0.8f, 247f)))`. Since foundation 1.8 the fling velocity threshold is fixed at `125dp/s`, close to the neutral `0.11` pt/ms; `state.animateTo(…)` moves it programmatically. Lists snap with `rememberSnapFlingBehavior` or a `Pager`.
- **Predictive back**: `PredictiveBackHandler { progress -> try { progress.collect { e -> /* drive the exit with e.progress */ }; /* committed */ } catch (e: CancellationException) { /* settle back */; throw e } }`.

```kotlin
fun rubberband(overshoot: Float, dimension: Float, c: Float = 0.55f): Float =
    (overshoot * dimension * c) / (dimension + c * abs(overshoot))
```

## Performance

- **Read animated values in lambda modifiers.** `Modifier.offset { IntOffset(0, y.roundToInt()) }` and `Modifier.graphicsLayer { scaleX = s }` read the value during layout or draw, so each frame skips recomposition ([Compose performance](https://developer.android.com/develop/ui/compose/performance/bestpractices)). `Modifier.offset(y = animatedDp)`, `Modifier.size(animatedDp)` and `Modifier.padding(animatedDp)` recompose and relayout every frame.
- **`AnimatedVisibility`'s default** `enter = fadeIn() + expandIn()` and `exit = shrinkOut() + fadeOut()` animate size, which is layout. Pass fade, scale or slide for surfaces; `animateContentSize()` is the tolerated accordion case.
- **Where it runs**: Compose animations tick on the main thread's frame clock (`withFrameNanos`), and the RenderThread draws. `graphicsLayer` properties skip recomposition and relayout but still need a main-thread frame, so a busy main thread hitches them too.
- **Shadows**: animate `graphicsLayer { shadowElevation = … }`, a render-node property, rather than recomposing `Modifier.shadow`.
- **Per-frame state**: a `mutableStateOf` written every frame and read in composition recomposes every reader; read it in a lambda modifier or use `Animatable`.
- **Record**: Perfetto system traces, `JankStats` in the field, Macrobenchmark's `FrameTimingMetric` in CI.

## Debugging

- **Slow motion**: Developer options ▸ Animator duration scale at `5x` or `10x`; Compose honors it.
- **Frame by frame**: Android Studio's Animation Preview scrubs `updateTransition`, `AnimatedVisibility`, `animate*AsState`, `Crossfade`, `rememberInfiniteTransition` and `AnimatedContent`.
- **Reduced motion**: set Animator duration scale to "Animation off", or turn on Accessibility ▸ Remove animations.
- **Real devices**: flicks, rubber-banding and predictive back need a device.

## Detection rows

The [detection checklist](../../references/motion/standards.md#detection-checklist) rows as they appear in Compose code.

| Detection | Fix |
| --- | --- |
| `scaleIn()` or `scaleOut()` with the default scale `0f` | `initialScale = 0.95f` (`targetScale` on exit) with `fadeIn`/`fadeOut` |
| `AnimatedVisibility` with default enter/exit on a popover-like surface | Fade plus scale from the trigger's `TransformOrigin` |
| `animate*AsState` or `AnimatedVisibility` for component motion with no `animationSpec` (`StiffnessMedium`, about `0.16s`) | `spring(1f, 247f)` or a `tween` with the strong curve |
| `EaseIn`, `FastOutLinearInEasing` or another accelerate curve on an entrance | The strong ease-out |
| `FastOutSlowInEasing` on custom component motion in a project without Material tokens | `CubicBezierEasing(0.23f, 1f, 0.32f, 1f)` |
| `DampingRatioLowBouncy`, `MediumBouncy` or `HighBouncy` outside a momentum release | `dampingRatio = 1f` |
| An animated value read in composition: `Modifier.offset(x = …)`, `size(…)`, `padding(…)` | `offset { }`, `graphicsLayer { }`, or a scale |
| `mutableStateOf` written in a `withFrameNanos` or `pointerInput` loop and read in composition | A lambda modifier or `Animatable` |
| Press scale other than `0.96`, or one that runs while disabled | `0.96`, gated on `enabled` |
| A press scale stacked on a Material component's ripple | The ripple alone, unless the design calls for both |
| Animated `Modifier.blur` above `20.dp` | Under `20.dp`; `2`–`5.dp` for a crossfade |
| A custom sheet or drawer drag where `ModalBottomSheet` fits | The Material component |
| `animateTo` after a drag with no `initialVelocity` | Pass the release velocity |
| `AnchoredDraggableState.settle(velocity)` | `AnchoredDraggableDefaults.flingBehavior(…)` on the modifier, or `animateTo` |
| A state change shown only by motion | A static cue, which "Remove animations" makes the only cue |
