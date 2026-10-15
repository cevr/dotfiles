# Color

Build and audit color systems: generate ramps, map their steps to roles and token names, convert notation and measure rendered contrast pairs.

Never report a contrast value you did not measure, and never estimate a color you could compute. Notation, a tinted neutral and a gradient's interpolation space are project choices, not findings. A broken role mapping, a failing pair and an out-of-gamut step are findings. Perceived lightness throughout means OKLCH `L`, from `0` to `1`.

Whether a pair is required to pass belongs to [accessibility](../accessibility/index.md). Surfaces, shadows and icon color belong to [surfaces](../surfaces.md) and [icons](../icons.md). Wiring tokens into an existing theme or component library is in [theming](../theming.md).

Implementation: [web](../../platforms/web/color.md) · [Apple](../../platforms/apple/color.md) · [Android](../../platforms/android/color.md)

Platform color systems are the platform convention: Apple's semantic system colors and Material 3's `ColorScheme` roles come before a hand-built palette, and their role names win on their platform ([Apple](../../platforms/apple/color.md#system-colors-first), [Android](../../platforms/android/color.md#the-material-scheme-wins)).

## Match the project's color system

Reuse the project's tokens and notation. A consistent hex system beats hex with OKLCH values scattered through it.

For a new system, build in OKLCH, because its numbers behave the way the ramp rules below describe. Everywhere else, a color library produces the same ramp in the project's own notation ([color-formats.md](color-formats.md)).

## A system is ramps, not colors

One neutral ramp, one accent ramp and only the status ramps the product actually renders. A `warning` ramp nothing imports is maintenance for zero pixels. A second accent hue earns its place only when two things must be distinguishable at a glance. Otherwise use more steps of the one accent ramp.

## Every step has a job

A ramp is not a gradient to pick from by eye. Each step exists because a role needs it: page background, component hover, border, solid fill, body text. Do not generate a step no role consumes. Both the Tailwind `50`–`950` and Radix `1`–`12` conventions map to those roles ([palette-structure.md](palette-structure.md)).

## Name primitives by hue, semantics by role

Primitives name a value (`blue-600`) and are never applied in a component. Semantic tokens name a job (`color-text-secondary`), point at a primitive and are the only tier components reference. That seam is what lets a theme repoint colors without touching components ([token-naming.md](token-naming.md)).

## Use a token only in its role

Never borrow a token because its value is right today. A separator used as a text color works until borders get lighter, and then the text goes with them. If a role has no token, add the token.

## Hold the hue across the ramp

A ramp holds one hue end to end, peaks in vividness mid-ramp and steps more finely at the light end. Build it with a color library, never by eye ([palette-generation.md](palette-generation.md)).

## One color, one meaning

Use a color for one purpose across the whole interface, treating anything within `15°` of OKLCH hue as the same color ([color-usage.md](color-usage.md)). Never let color be the only carrier of meaning. Pair it with an icon or a label, a requirement [accessibility](../accessibility/index.md) owns.

## Fill exactly one action per view

When filled color encodes primary emphasis, one primary action gets it and peers stay neutral. Put the color on the background, not the label. A filled button reads as primary across the room; accent-colored text on a neutral button reads as a link.

Keep an established hierarchy that already signals emphasis another way. Several colored backgrounds are fine when they encode distinct states or categories rather than competing as peers. How many primary actions a view carries, and where the rest go, is in [layout](../layout/index.md#one-primary-action-per-view).

## Measure the rendered pair, then report

Measure a foreground against the background it actually renders on, not the page background. When a pair fails, report the pair, its measured value and the threshold it misses, then leave the colors alone. They are a design decision. Change them only when asked, and remeasure after ([contrast.md](contrast.md)).

## Pick a gradient's interpolation space

The space is a look, not a correctness setting. Default to Oklab, and reach for OKLCH when a two-hue gradient goes gray in the middle ([color-usage.md](color-usage.md#gradients)).

## Reference files

| File | Read when |
| --- | --- |
| [palette-structure.md](palette-structure.md) | Deciding which ramps exist, mapping steps to roles (Tailwind and Radix), choosing neutrals and status hues, or inventorying an existing palette before restructuring it |
| [palette-generation.md](palette-generation.md) | Turning a brand color into a ramp, checking a ramp's properties, matching several hues or deriving dark mode |
| [color-formats.md](color-formats.md) | Choosing a color space, converting values, handling sRGB versus P3 gamut, or measuring colors resolved at render time |
| [contrast.md](contrast.md) | Measuring a pair against WCAG 2 or APCA thresholds, fixing a failing pair on request or picking text polarity |
| [color-usage.md](color-usage.md) | Applying meaning and emphasis, building gradients, handling cultural color meaning, or adding increased-contrast variants |
| [token-naming.md](token-naming.md) | Naming primitives and semantic tokens, or completing the role inventory |

## Before you finish

Each platform file adds the API-level patterns for these.

| Pattern | Fix |
| --- | --- |
| A color literal in a component where a token exists | Reuse or add the role token, in the project's notation |
| A primitive (`blue-600`) applied directly in a component | Point a semantic token at the primitive and use that |
| A semantic name containing a hue or a component, as in `color-blue-button` or `color-sidebar-gray` | Rename it for its role: `color-accent-solid`, `color-bg-surface` |
| `primary` meaning both the brand and the most prominent text | Rename the brand token `accent`, unless the platform fixes the word |
| A border or separator token used as text color, or a text token used as a background | Add a token for the missing role |
| Ramp values that differ only in HSL lightness | Rebuild in OKLCH with a constant hue |
| `50`–`200` stepping as far apart in OKLCH `L` as mid-ramp steps do | Tighten the light end to about `0.04`–`0.05` per step |
| One chroma or saturation number copied across every hue's ramp | Use the same proportion of each hue's own maximum |
| A status hue within `15°` of the accent hue | Move it at least `15°` away, or give the destructive action a distinct treatment |
| Dark tokens equal to the light ramp in reverse step order | Lower the accent's chroma, widen the dark end and remeasure every pair |
| Appearance switched by two mechanisms | Pick one and use it throughout |
| A contrast fix that changes hue and leaves lightness | Change lightness, the channel contrast responds to |
| One increased-contrast value shared by light and dark | Give each appearance its own increased-contrast value |
| Text on a color with alpha | Measure the rendered result, or use a solid token |
| White text on a mid-ramp (`500`) fill | Measure it; white on most `500` hues fails 4.5:1, so move the fill to `600` |
| A vivid P3 color with no sRGB base | Declare the sRGB value as the base and the vivid one only where P3 renders |

## Reporting

**Severity.** `HIGH` makes content unreadable or assigns a misleading semantic color. `MEDIUM` is a noticeable theme, token or gamut failure. `LOW` is isolated polish.

Three symptoms are `HIGH` on sight whatever the surface, matching the [cross-discipline review](../../workflows/review.md)'s escalation triggers. They are body or control text whose rendered pair fails its required ratio, state or meaning carried by color alone and a semantic color used against its meaning.

**Verification.** Without a render: token values, the gamut of every declared color, every appearance's values present and contrast computed from the declared token pair. With one (a browser, a preview, a simulator or emulator): the background actually rendered behind the text, including opacity and any image beneath it, measured in both light and dark. Report every check you could not run as `Not verified`.

**Format.** Group findings under the principle each violates, ordered by severity, one row per root cause listing every location it appears in:

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |

`Location` is `path/to/file:line`. `Why` names the principle and the user impact.

End with `Block` when any `HIGH` remains, `Approve` otherwise, leaving the rest in the table as work to do. Never `Approve` coverage you did not inspect. With nothing to report, state "No actionable color findings" and report verification.
