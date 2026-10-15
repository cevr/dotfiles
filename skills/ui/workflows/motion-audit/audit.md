# Motion audit categories

The eight audit categories, what each covers, and what to hunt for. The exact target values to cite in findings and plans live in the motion references linked from each category and in the platform's motion file; copy them, never approximate. Each category's hunt list is web first, then what the same finding looks like on Apple and Android. Severity follows [motion standards](../../references/motion/standards.md#severity).

## 1. Purpose and frequency

Every animation answers "why does this animate?" (feedback, spatial consistency, state indication, explanation, or preventing a jarring change), and its frequency tier decides how much motion it may carry. Rules: [frequency](../../references/motion/index.md#1-should-this-animate-at-all) and [purpose](../../references/motion/index.md#2-what-is-the-purpose).

Hunt for: animations on keyboard-initiated actions, command palettes with open/close transitions (Raycast has none, which is correct), decorative motion on list items or hover states hit constantly, expressive motion on tab switches and row hovers, state changes carried by motion alone with no static cue. The strongest fix is often **delete the animation**.

## 2. Easing and duration

Rules and values: [easing](../../references/motion/index.md#5-easing) and [duration](../../references/motion/index.md#6-duration). **`ease-in` on UI is always a finding.** Built-in keywords are too weak for component open/close and on-screen movement; plans introduce the strong custom curves as tokens, matching repo conventions. UI animations stay at or under 300ms.

Hunt for: `ease-in` anywhere, bare `ease`/`linear` on component entrances, durations over 300ms on UI elements, tooltip delay plus animation on every tooltip in a toolbar (after the first, they should be instant).

On Apple and Android, the system spring and the Material motion tokens are the platform convention ([precedence](../../SKILL.md#precedence)), so a component that uses them is not a finding. Hunt for the curve someone picked over them. Apple: `.easeIn`, `.linear` on an entrance, `.curveEaseIn` on `UIView.animate`, durations over 0.3 on UI. Android: `EaseIn`, `FastOutLinearInEasing`, `LinearEasing` on an entrance, `tween(durationMillis =` over 300 on UI.

## 3. Physicality and origin

Rules: [properties](../../references/motion/index.md#4-pick-the-properties), [popovers](../../references/motion/index.md#popovers-scale-from-their-trigger) and [buttons](../../references/motion/index.md#buttons-press-to-096). **Modals are exempt** from trigger origin: `transform-origin: center` is correct there. Do not report it.

Hunt for: `scale(0)`, pure-fade entrances with no initial transform on trigger-anchored surfaces, `transform-origin: center` (or none) on trigger-anchored elements, pressable elements with no press feedback, press scales other than `0.96`, disabled buttons that still scale.

Apple: `.transition(.scale)` with no `scale:` (it grows from zero), a scale with the default `.center` anchor on a trigger-anchored custom surface, a custom `ButtonStyle` that ignores `configuration.isPressed`. Android: `scaleIn()` with no `initialScale` (it defaults to `0f`), `transformOrigin` left at center on a trigger-anchored custom surface, `indication = null` with no other press feedback. System menus, popovers and sheets already animate from their anchor; hunt only in custom ones.

## 4. Interruptibility

Rules: [interruption](../../references/motion/index.md#8-interruption), [enter and exit](../../references/motion/index.md#9-enter-and-exit) and [gestures](../../references/motion/gestures.md). Anything triggered rapidly or reversible mid-motion (toasts stacking, toggles, drags, expand/collapse) uses transitions or springs. Symmetric timing on press-and-release is a finding.

Hunt for: `@keyframes` on toasts, toggles and rapidly-triggered UI; `animation:` on `:hover` or a toggled class; gesture handlers that tween with fixed-duration keyframes; drags without velocity-based dismissal (dismiss on `Math.abs(distance)/elapsedMs > ~0.11`, not distance thresholds alone); hard stops at drag boundaries instead of rising friction; springs that restart from the target value instead of the on-screen value; `bounce` above `0` outside a momentum release.

Apple: `keyframeAnimator` or `CABasicAnimation` on rapidly toggled UI; `UIView.animate` without `.beginFromCurrentState` on reversible motion; a `DragGesture` that ends on translation alone, ignoring `velocity` and `predictedEndTranslation`; a spring with `bounce` above `0` outside a momentum release. Android: a `LaunchedEffect` that calls `snapTo` the start value before animating (it restarts from zero rather than retargeting); `keyframes {}` on toggles; a release that drops the drag's velocity instead of passing it to `animateTo(…, initialVelocity =)` or an `AnchoredDraggableState`; `dampingRatio` below `1f` outside a momentum release.

## 5. Performance

Rules: [motion performance](../../references/motion/performance.md). `transition: all` is always a finding.

Hunt for: `transition: all` and `transition-all`, animated layout properties, animated `box-shadow`, Framer Motion shorthand props on motion that plays while the page is busy, `setProperty('--x', …)` driving child transforms, `setState` in rAF/pointer/scroll handlers, rAF loops doing what CSS could, animated `blur()` above `20px`, `will-change: all` or `will-change` on elements that never animate.

Apple: an animated `.frame`, padding or font size where `scaleEffect` or `offset` would do, animated `.shadow` or `.blur` across many views, `GeometryReader` writing `@State` on every frame, an `.animation(_:value:)` high on a container that animates everything beneath it. Android: an animated value read during composition (`Modifier.offset(x = value.dp)`, `padding`, `size`) where a deferred read (`Modifier.offset { }`, `graphicsLayer { }`) skips recomposition and relayout, an animated `Modifier.blur`, `animateContentSize` on every row of a long list.

## 6. Accessibility

Rules: [reduced motion and pointer gating](../../references/motion/index.md#reduced-motion-and-pointer-gating) and the [reduced-motion recipe](../../platforms/web/motion-recipes.md#reduced-motion-fallback). Reduced motion means fewer and gentler animations, **not zero**.

Hunt for: movement, scale or blur with no `prefers-reduced-motion`, `motion-safe:` or `MotionConfig` guard; ungated `:hover` motion; reduced-motion implementations that nuke all feedback; Motion's `reducedMotion="user"` relied on for a recipe that animates `filter`.

Apple: custom movement, scale or parallax with no `accessibilityReduceMotion` (`UIAccessibility.isReduceMotionEnabled`) check; system transitions adapt on their own, custom ones do not. Android: Compose reads `ANIMATOR_DURATION_SCALE` and jumps every animation to its end when the user removes animations, so the reduced path is zero motion, not gentler motion; a component that needs a gentle fallback (a crossfade in place of a slide) reads the setting itself, and one that does not is a finding.

## 7. Cohesion and tokens

Rules: [cohesion](../../references/motion/index.md#cohesion) and [component principles](../../references/motion/index.md#10-component-principles).

- Motion matches the product's personality: a dashboard stays crisp. Mismatched personality across components is a finding.
- Curves and durations live as shared tokens. Five hand-typed cubic-beziers that almost match is a consolidation finding, and so is the same detail animated two ways.
- Everything-at-once group entrances where a stagger belongs (`100ms` between semantic chunks, `30`–`80ms` between list items). Stagger is decorative and must never block interaction.
- A jarring crossfade that shows two overlapping states can be masked with a subtle 2pt blur during the transition: `filter: blur(2px)`, `.blur(radius: 2)`, `Modifier.blur(2.dp)` (Android 12 and later).
- Color transitions that smear on a theme switch.

Hunt for: duplicated near-identical easings and durations, one bouncy component in a crisp app, list and grid entrances with no stagger, crossfades that visibly double-expose, a theme toggle with no transition suppression, `AnimatePresence` state swaps animating on first render. Apple: spring and curve values typed inline instead of shared `Animation` constants. Android: specs typed inline instead of shared values or `MaterialTheme.motionScheme`.

## 8. Missed opportunities

The additive category: places that don't animate but should.

- State changes that teleport (content swaps, layout jumps) where a brief transition would prevent a jarring change.
- Spatially-connected UI (a panel that appears from a trigger) with no motion explaining where it came from.
- Rare, high-emotion moments (first run, success, celebration) rendered with none of the delight budget they're allowed.
- Offsets relative to the element's own size as tools for these, with no hardcoded offsets: `translate` percentages (`translateY(100%)` is the element's own height) and `clip-path: inset()` reveals on the web, `.move(edge:)` and edge-anchored transitions on Apple, `slideInVertically { it }` (the lambda receives the full height) on Android.

Report at most a handful, grounded in actual UX seams you observed, not a wishlist. Every candidate passes the gate in [motion opportunities](../motion-opportunities.md#the-gate).
