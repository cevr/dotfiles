# Color formats

Which color space to work in, how to convert between notations and what happens at the edges of a display's gamut. Every other rule in this color reference is stated perceptually and holds whatever notation you write.

Implementation: [web](../../platforms/web/color.md#notations) · [Apple](../../platforms/apple/color.md#formats-and-gamut) · [Android](../../platforms/android/color.md#formats-and-gamut)

## Choosing a space

| Space | Good for | Weakness |
| --- | --- | --- |
| sRGB (hex, RGB components) | Universal support, compact, what design tools hand you | Opaque. No channel corresponds to anything a designer thinks about |
| HSL | Channels look like design controls | Its lightness is not perceptual and its hue drifts; a ramp built by varying lightness bunches at one end and shifts hue |
| OKLCH | Perceptually uniform lightness, stable hue, predictable ramps | Native only on the web (`oklch()`); Apple and Android store sRGB or Display P3 components |

OKLCH has three channels: lightness `L` from `0` to `1`, chroma `C` from `0` to about `0.4`, hue `H` from `0` to `360`.

**Match whatever the project already uses.** Notation is not a defect: a project on hex is not doing it wrong.

**For a genuinely new color system, build in OKLCH.** Even lightness steps stay even, and a fixed hue stays fixed. Where the platform cannot store OKLCH, a color library emits the same values as hex or sRGB components. See [palette-generation.md](palette-generation.md).

## Converting

Convert when the user asks, when an agreed migration is in scope or when the project is standardizing on a notation and this value is the straggler. Never convert an isolated value in a project that deliberately uses something else and never because this reference happened to load.

When conversion is in scope, change the values and nothing else:

- Leave keywords and system colors alone: anything that names a color rather than spelling one (**Web:** `currentColor`, `transparent`; Apple's `Color.primary`; Material's `colorScheme` roles).
- Leave gradient definitions alone. Convert the color stops inside them; do not touch the interpolation method.
- Leave colors in third-party configs that expect a specific format.
- Preserve comments and formatting.

Bulk conversion is a migration, not cleanup. It shifts every rendered color by a rounding margin and touches files nobody asked about, so it has to be the task rather than a side effect.

## Gamut

Every sRGB color exists in Display P3, but not the reverse. The extra room is only at high chroma and varies by hue. At OKLCH `L` `0.65`, green gains about `0.07` of chroma while blue gains about `0.015`.

A color more vivid than its display can render gets gamut-mapped, which mostly means clipped. It flattens neighbouring steps into one rendered color, so the top of a ramp can lose its distinctions on an sRGB screen. Maximum vividness varies by hue and lightness. Cyans top out far lower than reds and purples, so a clipping ramp clips at some steps and not others.

The fix is to reduce vividness while holding hue and lightness. Generate ramps against sRGB unless the product is display-restricted, and add P3 as an enhancement: declare the sRGB value as the base and the vivid value only where the display renders it. The sRGB base is what makes an sRGB screen show a color you chose rather than one the renderer clipped. For example, `oklch(0.65 0.2 145)` (`#11ad32`) is the sRGB base and `oklch(0.65 0.27 145)` the P3 enhancement.

## Colors resolved at render time

Mixes, relative adjustments and opacity resolve at render time. Compute the resolved value with a color library, or measure the rendered result, before reporting contrast. Keep generated values out of the token layer, since a mixed color cannot be inspected in a design tool, and a token defined by three chained derivations is unreadable. **Web:** [`color-mix()`, relative color syntax and `light-dark()`](../../platforms/web/color.md#derived-colors).
