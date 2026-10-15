# Layout on Android

Jetpack Compose implementation of [layout](../../references/layout/index.md). The rules, values and reasons live there; this file maps each one to the API and names where Material 3 replaces a value.

## Platform values that win

| Neutral value | Material 3 value | Notes |
| --- | --- | --- |
| Spacing steps | An `8dp` scale (`space100` = `8dp`); the tokens are 0, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 32, 36, 40, 48, 56, 64 and `72dp` | Text in `sp`, everything else in `dp` |
| Layout margin `16pt` | `16dp` compact; `24dp` medium; `24dp` expanded | |
| Space between panes | `24dp` | The pane scaffolds' default spacer from expanded width up |
| Breakpoints from content | Window size classes, by width: compact `<600dp`, medium `600–839dp`, expanded `840–1199dp`, large `1200–1599dp`, extra-large `≥1600dp`; by height: compact `<480dp`, medium `480–899dp`, expanded `≥900dp` | Classes describe the window, not the device: split screen, freeform windows and folding change them at runtime. Never write `isTablet` logic. |
| Hit-target clearance | `48×48dp` minimum target, owned by [accessibility](../../references/accessibility/hit-areas.md#target-sizes) | |

## Rule to API

| Rule | Compose |
| --- | --- |
| [Group with space](../../references/layout/grouping-and-alignment.md#group-with-space-not-lines) | `Column(verticalArrangement = Arrangement.spacedBy(24.dp))` of `spacedBy(8.dp)` groups; `HorizontalDivider` only in dense lists |
| [Controls distinct from content](../../references/layout/grouping-and-alignment.md#keep-controls-distinct-from-content) | `Button`, `FilledTonalButton`, `OutlinedButton`; `TextButton` for an inline action, which takes the primary color |
| [Shared edges](../../references/layout/grouping-and-alignment.md#align-to-shared-edges) | One `Modifier.padding(horizontal = 16.dp)` on the container; `Row(verticalAlignment = Alignment.CenterVertically)` or `Modifier.alignByBaseline()`; `ListItem` for leading/headline/trailing rows |
| [Leading and trailing](../../references/layout/grouping-and-alignment.md#leading-and-trailing-for-anything-that-mirrors) | `padding(start =, end =)`, `Arrangement.Start/End`, `Alignment.Start/End/CenterStart`, `TextAlign.Start/End`, `RoundedCornerShape(topStart =, …)`, `Modifier.offset(x)` — all mirror in `LayoutDirection.Rtl` |
| [Order by importance](../../references/layout/grouping-and-alignment.md#order-by-importance) | TalkBack follows layout order; `Modifier.semantics { traversalIndex = … }` only where the visual order can't follow it |
| [One primary action](../../references/layout/index.md#one-primary-action-per-view) | One filled `Button` or one `FloatingActionButton`/`ExtendedFloatingActionButton`; secondary actions in a `TopAppBar` overflow `DropdownMenu` |
| [Hint at hidden content](../../references/layout/spacing-and-adaptivity.md#hint-at-hidden-content) | Peek (below); `AnimatedVisibility` behind an expand `IconButton`; `Text(maxLines =, overflow = TextOverflow.Ellipsis)` plus a "More" control; `TooltipBox` opens on long-press and hover, so pair it with another route for keyboard and TalkBack |
| [Clearance](../../references/layout/spacing-and-adaptivity.md#borderless-controls-need-more-clearance) | `Row(horizontalArrangement = Arrangement.spacedBy(12.dp))`; `IconButton` already carries a `48dp` target around its `24dp` icon |
| [Inset buttons](../../references/layout/spacing-and-adaptivity.md#inset-buttons-from-the-edges) | `Scaffold(bottomBar = { … })` holding a `Button(Modifier.fillMaxWidth().padding(16.dp))`, or a `BottomAppBar`; the slot applies the navigation-bar inset |
| [Content bleeds, controls float](../../references/layout/spacing-and-adaptivity.md#content-bleeds-controls-float) | Below |
| [Hold structure](../../references/layout/spacing-and-adaptivity.md#hold-structure-until-it-breaks) | Below |
| [Growth and clipping](../../references/layout/spacing-and-adaptivity.md#plan-for-growth-and-clipping) | Below |

## Edge-to-edge and insets

Edge-to-edge is enforced once an app targets SDK 35 and runs on Android 15+. The `windowOptOutEdgeToEdgeEnforcement` opt-out is disabled for apps targeting SDK 36 on Android 16. Call `enableEdgeToEdge()` in `onCreate` so older versions match, and set `android:windowSoftInputMode="adjustResize"` to receive IME insets.

```kotlin
Scaffold(topBar = { TopAppBar(title = { Text("Inbox") }) }) { innerPadding ->
    // Content scrolls under the bars but rests clear of them
    LazyColumn(contentPadding = innerPadding) { /* … */ }
}
```

- Backgrounds and media draw full-bleed; padding goes on the content. `Modifier.safeDrawingPadding()` (= `windowInsetsPadding(WindowInsets.safeDrawing)`) keeps content clear of bars and display cutouts; `WindowInsets.safeGestures` and `safeContent` also clear system gesture zones, for carousels and bottom sheets.
- Pass `innerPadding` as a list's `contentPadding`, not as `Modifier.padding`, or content stops at the bar instead of scrolling under it.
- `Modifier.consumeWindowInsets(…)` tells children that a parent already applied an inset, so it isn't applied twice.
- `imePadding()` (or `WindowInsets.ime`) keeps a focused field and the action row above the keyboard.
- The `Scaffold` `floatingActionButton` slot positions the FAB from the end edge with the right insets and mirrors it in RTL.

## Adaptivity

```kotlin
val sizeClass = currentWindowAdaptiveInfo(supportLargeAndXLargeWidth = true).windowSizeClass
val twoPane = sizeClass.isWidthAtLeastBreakpoint(WindowSizeClass.WIDTH_DP_EXPANDED_LOWER_BOUND)
```

`currentWindowAdaptiveInfo()` (`androidx.compose.material3.adaptive`) returns a `WindowAdaptiveInfo` with `windowSizeClass` (`androidx.window.core.layout`) and `windowPosture`. Without `supportLargeAndXLargeWidth = true`, large and extra-large widths report as expanded. Check height too: a phone in landscape is medium width but compact height, too short for two stacked panes.

| Canonical layout | API | Behavior |
| --- | --- | --- |
| Navigation | `NavigationSuiteScaffold` | Navigation bar, rail or drawer by window size |
| List-detail | `ListDetailPaneScaffold` + `rememberListDetailPaneScaffoldNavigator()` | Both panes from expanded width; one at a time below it. Add a `BackHandler` when the detail pane shows alone. |
| Supporting pane | `SupportingPaneScaffold` + `rememberSupportingPaneScaffoldNavigator()` | Compact: supporting content below the main pane or in a bottom sheet. Medium: equal split. Expanded: 70% main, 30% supporting. |
| Feed | `LazyVerticalGrid(columns = GridCells.Adaptive(minSize = 180.dp))` | One column on compact width, more as width allows |

- **Component level:** `BoxWithConstraints` reads the space the parent gives, the container-relative decision; `FlowRow` wraps buttons and chips; `Modifier.widthIn(max = …)` caps a reading column on wide windows.
- **Foldables:** `windowPosture.isTabletop` and `windowPosture.hingeList` (`bounds`, `isSeparating`, `isOccluding`). The pane scaffolds default to `HingePolicy.AvoidSeparating` and split vertically in tabletop posture; hand-built layouts keep content and controls off a separating hinge.

## Growth and clipping

- In a `Row`, give the text column `Modifier.weight(1f)` so it wraps or ellipsizes; fixed items such as an avatar keep their intrinsic size.
- `Modifier.heightIn(min = …)` instead of `height(…)` on anything holding text; a capped box scrolls with `verticalScroll`.
- Text sizes stay in `sp` so they follow the system font scale up to 200%; test at the largest scale.
- Dialogs: M3 `AlertDialog` keeps its buttons outside the scrolling text; full-screen dialogs put actions in the top app bar.

## Mirroring for RTL

Mirrors automatically: `Row`, `Arrangement.Start/End`, `start`/`end` padding, `Modifier.offset`, `RoundedCornerShape(topStart…)`. Stays physical: `Modifier.absoluteOffset`, `Modifier.absolutePadding`, `Arrangement.Absolute.Left/Right`, `AbsoluteRoundedCornerShape`, and anything drawn in `Canvas` or `drawBehind`, where `layoutDirection` in the `DrawScope` decides. Preview with `@Preview(locale = "ar")` or `CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl)`. Directional icons are in [Android icons](icons.md#rtl).

## Peeking carousel

```kotlin
BoxWithConstraints {
    val itemWidth = maxWidth - 48.dp - 12.dp // content width (24dp inset each side) + 12 gap - 24 peek
    val state = rememberLazyListState()
    LazyRow(
        state = state,
        contentPadding = PaddingValues(horizontal = 24.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        flingBehavior = rememberSnapFlingBehavior(state, SnapPosition.Start),
    ) {
        items(cards) { card -> CardItem(card, Modifier.width(itemWidth)) }
    }
}
```

`SnapPosition.Start` snaps each item's start to the content-padding edge, `24dp` in from the row's edge. Material 3's `HorizontalMultiBrowseCarousel` and `HorizontalUncontainedCarousel` are the system carousels when the design allows them.

## Before you finish

| Detection pattern | Fix |
| --- | --- |
| `absolutePadding`, `absoluteOffset`, `Arrangement.Absolute.*` or `AbsoluteRoundedCornerShape` on mirrored UI | The `start`/`end` form |
| `Modifier.padding(innerPadding)` on a `LazyColumn` inside `Scaffold` | `contentPadding = innerPadding` |
| No `enableEdgeToEdge()`, or content clipped under the status or navigation bar | Call it; pad content with `safeDrawingPadding()` or the `Scaffold` padding |
| `LocalConfiguration.current.screenWidthDp`, `smallestScreenWidthDp` or an `isTablet` resource deciding layout | `currentWindowAdaptiveInfo().windowSizeClass`, or `BoxWithConstraints` for a component |
| `Modifier.height(…)` with a literal on a composable holding `Text` | `heightIn(min = …)` |
| A `Row` with a long `Text` and no `weight` | `Modifier.weight(1f)` on the text |
| Text size in `dp` | `sp` |
| Spacing values off the `4dp` grid (`10.dp`, `14.dp`) without a design reason | The nearest step in the project's scale |

Verify in previews at phone and tablet `device` specs, a foldable spec, `fontScale = 2f` and `locale = "ar"`, and on a device with gesture and three-button navigation.
