# Apple

How the skill's rules are built for iOS, iPadOS, macOS, watchOS, and visionOS. Read this after [SKILL.md](../../SKILL.md) for any Apple project, then the domain references with their Apple files below.

## Stack

- **Framework**: SwiftUI first. Drop to UIKit or AppKit (through `UIViewRepresentable` / `NSViewRepresentable`, or the reverse with hosting controllers) only for what SwiftUI cannot do, and follow the project where it is already UIKit or AppKit.
- **Language**: the `write-swift` skill owns Swift itself: concurrency, value types, API design, performance, testing. This skill owns what the interface looks like and how it behaves.
- **System**: the Human Interface Guidelines are the platform convention ([precedence](../../SKILL.md#precedence)). Standard navigation (`NavigationStack`, `NavigationSplitView`, `TabView`), presentation (`sheet`, `popover`, `confirmationDialog`, `alert`), and controls (`Button` styles, `Toggle`, `Picker`, `Menu`, `List`, `Form`) come before custom ones. They carry Dynamic Type, VoiceOver, keyboard, pointer, and platform adaptation for free.
- **Theme**: semantic colors (`Color.primary`, `.secondary`, `Color(.systemBackground)`, `.tint`) and asset-catalog colors with light, dark, and high-contrast appearances; Dynamic Type text styles (`.font(.body)`); SF Symbols for icons; system materials for translucency.
- **Animation**: SwiftUI animations and transitions, springs by default. → [motion](../../references/motion/index.md)

## Apple References

| File | Read when |
| --- | --- |

## Verify

Render each state in Xcode previews (`#Preview`, one per state or a grid of them) and run it in the simulator. Check light and dark, Increase Contrast, the largest accessibility Dynamic Type size, Reduce Motion, Reduce Transparency, a right-to-left locale, the smallest supported device and iPad (or a narrow and wide macOS window), and VoiceOver on anything interactive. Animation feel needs a device: the simulator drops frames a phone would not.
