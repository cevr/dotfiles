# Build design

Build UI from a Figma file or a design image so it matches the design, using the project's existing tokens and components. It reads the design at its source, builds with what the project already has, then compares the result against the design before calling it done.

The design decides. Values come from the design file, never from your taste or a pattern you liked elsewhere. A change the design does not show is a deviation, and a deviation is the user's call.

This mode owns no domain rules. Where the design breaks one, build it as designed and report the conflict with its owner. Contrast is a requirement in [accessibility](../references/accessibility/index.md) and a measurement in [color](../references/color/contrast.md). Focus and semantics are [accessibility](../references/accessibility/index.md), type is [typography](../references/typography/index.md) and spacing and structure are [layout](../references/layout/index.md). Palette is [color](../references/color/index.md), copy is [writing](../references/writing/index.md), surfaces are [surfaces](../references/surfaces.md), icons are [icons](../references/icons.md) and motion is [motion](../references/motion/index.md). Mapping values onto the project's tokens follows [theming](../references/theming.md). Reviewing finished work is [review](review.md), exploring alternatives is [variants](variants.md) and stress testing a component is [stress-test](stress-test.md).

## 1. Read the design at its source

A Figma link means the Figma MCP. Search the available and deferred tools for `figma` before saying it is unavailable, since the server often sits under a name you did not expect. A server that lists only an authenticate tool is connected but signed out, so ask the user to authenticate. With no Figma tool at all, ask the user to connect one, and do not build from memory or guesswork meanwhile. [figma.md](build-design/figma.md) holds which tools to call and what each returns.

A screenshot or exported image has no values to read. Sizes are ratios to the capture, so state the scale you assumed and treat every measurement as an estimate. A device screenshot whose resolution identifies the device converts to points by its scale (1179×2556 is a 3× iPhone, 393×852pt); say which device you assumed. Ask for the Figma link when one exists, since it replaces the whole estimate.

Scope the run to the frames named. Frames that show the same thing at different widths are one piece at several breakpoints, not separate pieces.

This step is done when you hold a screenshot of every frame in scope and its values for spacing, size, radius, color, type and the components used. From a Figma file they are exact. From an image they are estimates at the scale you stated.

## 2. Map the design onto the project

Read the project's tokens and component library before writing anything. They live in a different place on each platform:

| Design value | Web | Apple | Android |
| --- | --- | --- | --- |
| Color | CSS variables, the Tailwind theme | Asset-catalog color sets, semantic colors (`.primary`, `Color(.systemBackground)`), the project's `Color` extensions | `MaterialTheme.colorScheme` roles, `colors.xml` |
| Type | The type utilities or CSS variables | Dynamic Type text styles (`.body`, `.headline`) or the project's font extensions | `MaterialTheme.typography` styles |
| Spacing, size, radius | The spacing scale and radius tokens | The project's spacing and radius constants | `dimens.xml`, the project's spacing object, `MaterialTheme.shapes` |
| Components | The project's components, then the library's | The project's views, then system controls | The project's composables, then Material 3 components |

On Apple and Android, a design text size maps to the text style nearest it, never to a fixed size, so the text still follows the user's text size; list it as rounded when the sizes differ. Where the platform convention has its own value for a control (a navigation bar, a system button, a Material component's height), the platform value wins and the difference is reported as rounded ([precedence](../SKILL.md#precedence)).

Then map every design value to what exists:

| In the design | In code |
| --- | --- |
| A bound variable or style | The token with the same name or the same value |
| A raw value that equals a token | That token |
| A raw value with no token | The nearest existing token, listed in the report as rounded |
| A component instance | The project's component of that name, with the variant the design shows |
| A component instance with no project equivalent | Plain markup or view code in place, listed as a deviation, and ask whether a component should exist |
| A one-off group of layers | Plain markup or view code in place, not a new component |

Never add a token, a component variant or an arbitrary value to hit a number. Stop and ask which way to go when rounding would visibly change the design. That means more than 2pt on spacing or size, or a color landing on a different step.

Check what data the design needs and wire it to what exists. Where the backend for part of it does not exist yet, build that part as UI fed by its inputs (props, initializer parameters, composable parameters) and name it in the report as unwired.

## 3. Build only what the design shows

Implement the frames, the breakpoints the frames define and the states the file draws, such as hover, empty or error. A state the file does not draw is not yours to design. Leave it to the existing component's default and list it as missing.

Leave everything around the piece as it was. No neighbouring copy edits, no icon swaps, no "while I was here" cleanups. A diff wider than the design is the most common way this goes wrong.

## 4. Compare against the design

Render the build at each frame's width beside the design screenshot and walk it element by element. On the web, that is the page at each width. On Apple and Android, it is a simulator or emulator whose screen width in points matches the frame (a 393-wide frame is a 393pt iPhone), or a preview at that width; a captured screenshot is in device pixels, so divide by the device's scale before comparing sizes. [Harness](harness.md#looking-at-it) has the capture commands. Compare the properties **Read the design at its source** collected. "Gap is 12px, design is 16px" is a finding. "Feels a bit tight" is not.

With a way to render at hand, capture each width and compare. Without one, hand over what the user opens (the local URL, or the preview or simulator target) with the widths to check, and say the comparison is unverified. Do not report a match you did not look at.

Fix every mismatch you caused, then compare again. This step is done when every remaining difference is a rounding or a question.

## 5. Report and stop

Built values in the project's idiom; the example is web.

| Element | Design | Built | Status |
| --- | --- | --- | --- |
| Card padding | 20px | `p-5` | Matches |
| Title size | 15px | `text-sm`, 14px | Rounded to token |
| Badge | Filled pill | Text label | Deviates, asked: no badge component exists |

Then list, one line each, and omit a list with nothing in it:

- **Unwired.** What renders from props until the backend exists.
- **Missing states.** What the design does not draw.
- **Domain conflicts.** Where the design breaks a rule, with the owning reference.

Close by saying where the build is running and at which widths you compared.

## Before you finish

| You notice | Fix |
| --- | --- |
| "Figma isn't connected" written before any tool search | Search the tools for `figma` first |
| Values in code that appear in no Figma response, only in the screenshot | Read them from the design context |
| An arbitrary value in the diff: `w-[343px]`, a raw hex, `.frame(width: 343)`, `Color(red:green:blue:)`, `Color(0xFF…)`, `.font(.system(size: 15))`, `fontSize = 15.sp` | Map it to a token or text style, or ask if rounding shows |
| A new file under the components directory for a frame that is not a component | Inline it as plain markup or view code |
| A loading or error branch the design never drew | Remove it, keep the default and list it as missing |
| Files in the diff that no frame touches | Revert them |
| A contrast or focus change the design does not show | Restore the design and report the conflict with its owner |
| A comparison claimed with no screenshot of the build | Render each frame width, or say it is unverified |
| Figma's generated React and Tailwind pasted, or ported line by line, into Swift or Kotlin | Read the values from variables and layers, and build with the platform's components |
| Hard-coded sample data with no mention in the report | List it under **Unwired** |
