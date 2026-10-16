# The harness

Where [states](states.md), [stress-test](stress-test.md) and [variants](variants.md) render the real component with fixture data, and how those workflows and [build-design](build-design.md) look at what rendered. Each workflow says what goes on the harness; this file says where it lives on each platform, how to see it and how to judge it.

## Where it lives

| | Web | Apple | Android |
| --- | --- | --- | --- |
| Surface | A scratch route inside the app, in one folder such as `/states/audit-log` | A `#Preview` per state or scenario in one Swift file beside the component; a debug-only screen (`#if DEBUG`) run in the simulator where a preview cannot build the view | A `@Preview` per state or scenario in one Kotlin file beside the component, or one `@Preview` taking `@PreviewParameter` from a `PreviewParameterProvider` for a data set; the emulator for what a preview cannot render |
| Inherits | The app's layout, fonts, global styles and providers, for free | Asset-catalog colors and fonts; wrap the instance in whatever the app root injects (`.environment` objects, the app's theme modifiers) | Resources; wrap the instance in the app's own theme composable (the one that sets `MaterialTheme`) |
| Boundary trap | Where the framework splits server from client components, the page is client code, `"use client"` in Next, or fixture data silently vanishes crossing that boundary | A view that builds its own model (`@State private var model = Model()`, a shared singleton) ignores fixtures; preview the view that takes the model as input | A screen that obtains its ViewModel (`hiltViewModel()`, `viewModel()`) does not render in a preview; preview the stateless content composable it calls |
| A fixed width | A fixed-width container on the page | `.frame(width: 320)` around the instance, with the preview at `traits: .sizeThatFitsLayout` | `@Preview(widthDp = 320)`, or `Modifier.width(320.dp)` around the instance |
| Removal | Delete the folder | Delete the preview file, or the debug screen and its entry point | Delete the preview file |

`#Preview("Name", arguments: […]) { value in … }` renders one preview per value, the Apple counterpart of `PreviewParameterProvider`; it needs the iOS 26 / macOS 27 SDK. Below that, write one `#Preview` per value.

A native component always has a project, so the harness goes there. Only the web has a standalone case, and the workflow that allows it says how.

## Looking at it

| | Web | Apple | Android |
| --- | --- | --- | --- |
| See it | A browser already at hand | Xcode's preview canvas, or the app in the simulator | Android Studio's preview pane, or the app on an emulator |
| Capture a screenshot | The browser tool's screenshot | `xcrun simctl io booted screenshot shot.png` | `adb exec-out screencap -p > shot.png` |
| Record motion | The browser tool's screencast | `xcrun simctl io booted recordVideo clip.mov`, Control-C to stop | `adb shell screenrecord /sdcard/clip.mp4`, Control-C to stop (3 minutes at most), then `adb pull /sdcard/clip.mp4` |
| Render headless | — | The project's snapshot tests, where it has them | The project's preview screenshot tests (`./gradlew updateDebugScreenshotTest` with the Compose Preview Screenshot Testing plugin), Paparazzi or Roborazzi, where it has them |

Previews render only inside Xcode and Android Studio. From a terminal, the reachable route is a build installed on the simulator or emulator plus the capture command, or the project's existing snapshot tests. Adding a snapshot-testing dependency to see a throwaway harness is out of scope.

With no way to render at hand, say so and hand over what the user opens: the URL on the web, the preview file and the preview names on Apple and Android.

## Judging it

Judge what rendered from the screenshot, not from the code: you wrote the code, so you read your intent into it. Make each pass on its own, at every width you rendered:

1. **One second.** Glance and look away. Say what the screen is for and what to do next. Two answers, or none, means the hierarchy is split ([interface judgment](../references/interface-judgment.md)).
2. **Squint.** Blur it until text is grey bars, and name the two or three biggest masses. The content the user came for, or the one primary action, is one of them.
3. **Edges.** Follow the leading edge of each text block down each column and count the distinct positions. Two or three, reused, read as aligned; six read as placed one at a time ([shared edges](../references/layout/grouping-and-alignment.md#align-to-shared-edges)).
4. **Space.** Call each empty region a rest (it groups on purpose) or a hole (something is missing or misplaced). The gap between groups is at least twice the gap inside one ([layout](../references/layout/index.md)).
5. **Type.** Count the text sizes on screen against the project's scale. Find any line past the measure and any heading that ends on one word ([typography](../references/typography/index.md)).
6. **Color.** Say where the accent is and what it means there. It keeps its one meaning and fills one primary action per view; anywhere else it stops meaning "here" ([color usage](../references/color/color-usage.md)).
7. **Collisions.** Text over text, text cut by its container, a sticky bar over content, anything past the edge.
8. **Compact width.** Judge the narrow screenshot as a layout of its own: the one-second answer and the primary action survive, not the wide layout stacked.

Write each round in one shape, so rounds compare:

    ROUND n · <screen> · <widths>
    Seen in one second: …
    Masses: …
    Leading edges: n · Text sizes: n
    Top three problems, most visible first, each with its screenshot, the region and the fix:
    1. …

Name a problem as a designer tells a colleague: "the filter row starts 12pt right of the table's edge", never "could be more polished". Fix in this order, since a later fix cannot rescue an earlier one: hierarchy, composition, type, color, detail, motion. Fix the top three, render again and judge again. Stop when a round finds nothing a stranger would notice, or after three rounds, and list what remains plainly. A finding from this pass cites its screenshot, and its fix cites the code ([review](review.md#5-require-evidence)).

## Viewing modes

On the web, dark mode, zoom and reduced motion are the user's to toggle in the browser; the harness renders none of them. On Apple and Android, a preview override sets the same environment value the system sets, so the harness may render the mode:

| Mode | Apple preview | Android preview |
| --- | --- | --- |
| Dark | `.preferredColorScheme(.dark)` | `@PreviewLightDark`, or `uiMode = Configuration.UI_MODE_NIGHT_YES` |
| Largest text | `.dynamicTypeSize(.accessibility5)` | `@PreviewFontScales`, or `fontScale = 2f` |
| Right to left | `.environment(\.layoutDirection, .rightToLeft)` | `@Preview(locale = "ar")` |

UIKit and AppKit views hosted inside a preview follow traits rather than the SwiftUI environment; check those in the simulator. On a running simulator or emulator, set the mode system-wide. Simulator: `xcrun simctl ui booted appearance dark`, `xcrun simctl ui booted content_size accessibility-extra-extra-extra-large`, `xcrun simctl ui booted increase_contrast enabled`; reset with `light`, `large` and `disabled`. Emulator: `adb shell cmd uimode night yes`, `adb shell settings put system font_scale 2.0`; reset with `night no` and `1.0`.
