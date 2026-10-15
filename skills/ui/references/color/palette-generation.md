# Palette generation

Producing the values once the structure is decided. For which ramps to build and what each step is for, see [palette-structure.md](palette-structure.md).

Implementation: [web](../../platforms/web/color.md#appearance-switching) · [Apple](../../platforms/apple/color.md#appearances) · [Android](../../platforms/android/color.md#the-material-scheme-wins)

## Start from the brand color

A brand color arrives as one value, usually a hex. Two decisions come before any ramp exists:

**Which step does it occupy?** A brand color meant for buttons and links belongs on the solid-fill step, `600` in Tailwind and `9` in Radix. Then the primary button renders the actual brand color, not an approximation.

**Is it pinned or snapped?** Pin a contractually fixed brand color. It stays exact, the ramp builds outward from it and that one step spaces slightly unevenly. Otherwise snap it onto the ramp so the spacing stays regular, which almost always looks better.

A brand color that fails contrast behind white text is still the brand color, just not the solid-fill step. Put it where it lands and use a darker step for interactive fills. Never quietly darken the brand. In the example below, `#3b82f6` lands on `500` and fills use `600`, because white on `#3b82f6` measures 3.68:1.

## What a correct ramp looks like

Properties of the finished ramp, checkable against any output in any notation:

- **Lightness changes steadily, measured in OKLCH `L`.** HSL lightness is not perceptual, and evenly spaced HSL values bunch at one end.
- **Hue is constant end to end.** Every step is recognisably the same color. A wandering hue reads as two colors blended and will not sit correctly against a neutral built on a different hue.
- **Vividness peaks in the middle and falls off at both ends.** The lightest and darkest steps are nearly neutral; the middle carries the color. Holding full vividness into the extremes gives a `50` that glows and a `950` like ink spilled on the brand.
- **Steps are finer at the light end.** Light backgrounds need finer distinctions than dark ones. Keep `50`–`200` about `0.04`–`0.05` apart in OKLCH `L` and mid-ramp steps about `0.07`–`0.10`. Even spacing across the whole range leaves too few pale steps, so `100` is already too dark for a subtle surface.
- **No two adjacent steps are indistinguishable.** Adjacent steps less than `0.03` apart in OKLCH `L` mean the ramp has more steps than decisions. Drop one.
- **Both ends stop short of pure black and white.** A ramp that reaches them loses its identity exactly where the page background lives.

## Use a color library

Never compute these by hand or by eye. Run a color library once at design time, whatever the target platform: `culori`, `colorjs.io` and `chroma.js` (JavaScript) all convert between notations, measure perceived lightness and interpolate perceptually. Read the brand color in whatever format it arrives, do the math in a perceptual space and emit the project's notation:

```js
import { formatHex, interpolate, samples } from 'culori'

// Perceptual interpolation, hex in and hex out.
const ramp = interpolate(['#eff6ff', '#3b82f6', '#172554'], 'oklab')
const steps = samples(11).map((t) => formatHex(ramp(t)))
```

This is a starting point. Linear sampling spaces lightness evenly within each segment, so check the output against the properties above and tighten `50`–`200` by hand.

The output format is the project's choice. For a ramp the interpolation space is not, because sRGB interpolation produces muddy mid-steps. Decorative gradients are the opposite case, where the space is a deliberate look ([color-usage.md](color-usage.md)).

For comparison, Tailwind's blue ramp has the finer light end the generated one lacks:

| Step | `50` | `100` | `200` | `300` | `400` | `500` | `600` | `700` | `800` | `900` | `950` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Blue | `#eff6ff` | `#dbeafe` | `#bfdbfe` | `#93c5fd` | `#60a5fa` | `#3b82f6` | `#2563eb` | `#1d4ed8` | `#1e40af` | `#1e3a8a` | `#172554` |

## Several hues at once

With an accent plus status ramps, the ramps must agree step for step. `red-500` and `blue-500` should read as equally bright and vivid, or a red button looks heavier than a blue one at the same step.

- **Match perceived lightness exactly.** Same step, same brightness, across every hue.
- **Match vividness relatively, not absolutely.** Hues do not share a maximum vividness. A saturated yellow and a saturated blue are not equally far from gray, and no format makes them so. Set each ramp to the same *proportion* of what its own hue reaches.

Yellows and cyans are the usual casualties, peaking much lower than reds and blues. Copy the numbers across and the warning color looks weak beside the danger one.

## Dark mode

A dark palette is not the light one reversed. Reversal is the starting point, not the output.

Swap the semantic roles first, then tune the values:

| Role | Light | Dark |
| --- | --- | --- |
| Page background | `neutral-50` | `neutral-950` |
| Primary text | `neutral-950` | `neutral-50` |

Three things almost always need hand-tuning after the swap:

- **Vividness comes down.** A color that reads as confident on white reads as neon on near-black. Dark appearances need the accent a step or two less vivid.
- **The dark end needs more separation.** Steps distinguishable as pale backgrounds collapse into each other as dark surfaces.
- **Contrast does not survive the mirror.** APCA scores mirrored pairs differently, so recheck every pair in both appearances ([contrast.md](contrast.md)).

### One switching mechanism

Switch every color between appearances through one mechanism, whichever the platform offers. Tokens switched by two mechanisms give a half-themed interface the moment a user overrides the system preference. The mechanisms are in [web](../../platforms/web/color.md#appearance-switching), [Apple](../../platforms/apple/color.md#appearances) and [Android](../../platforms/android/color.md#appearances).
