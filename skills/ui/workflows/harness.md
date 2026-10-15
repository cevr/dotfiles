# The harness

Where [states](states.md), [stress-test](stress-test.md) and [variants](variants.md) render the real component with fixture data, and how those workflows and [build-design](build-design.md) look at what rendered. Each workflow says what goes on the harness; this file says where it lives on each platform and how to see it.

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

## Viewing modes

On the web, dark mode, zoom and reduced motion are the user's to toggle in the browser; the harness renders none of them. On Apple and Android, a preview override sets the same environment value the system sets, so the harness may render the mode:

| Mode | Apple preview | Android preview |
| --- | --- | --- |
| Dark | `.preferredColorScheme(.dark)` | `@PreviewLightDark`, or `uiMode = Configuration.UI_MODE_NIGHT_YES` |
| Largest text | `.dynamicTypeSize(.accessibility5)` | `@PreviewFontScales`, or `fontScale = 2f` |
| Right to left | `.environment(\.layoutDirection, .rightToLeft)` | `@Preview(locale = "ar")` |

UIKit and AppKit views hosted inside a preview follow traits rather than the SwiftUI environment; check those in the simulator. On a running simulator or emulator, set the mode system-wide (unverified, confirm with `xcrun simctl help ui` and on a device): `xcrun simctl ui booted appearance dark`, `xcrun simctl ui booted content_size accessibility-extra-extra-extra-large`; `adb shell cmd uimode night yes`, `adb shell settings put system font_scale 2.0`.
