# Contrast

Contrast is measured between a **foreground color**, meaning text, an icon or a UI element, and the **background color** it actually renders against, usually the nearest ancestor that paints one. Identify that background first. Measuring against the page background when the element sits on a card gives the wrong answer.

[Accessibility](../accessibility/index.md) decides which requirement applies to a pair. The thresholds below are what a measured pair is reported against. Where neither the accessibility reference nor the project names a standard, report the WCAG 2 result and add the APCA value.

Implementation: [web](../../platforms/web/color.md) · [Apple](../../platforms/apple/color.md#measuring-contrast) · [Android](../../platforms/android/color.md#measuring-contrast)

## WCAG 2 thresholds

WCAG 2 is the standard formal conformance claims are made against.

| Content type | AA | AAA |
| --- | --- | --- |
| Text | 4.5:1 | 7:1 |
| Large text, at least `24pt` or `18.67pt` bold (WCAG's 18 and 14 print points) | 3:1 | 4.5:1 |
| UI components and graphical objects | 3:1 | n/a |

Disabled or inactive controls and logos are exempt.

## APCA thresholds

Lc, Lightness Contrast, is APCA's measure of perceived contrast. These levels simplify APCA's full font-size and weight lookup table:

| Content type | Minimum |
| --- | --- |
| Body text, columns or blocks of text | Lc 75, preferred Lc 90 |
| Non-body text such as labels and headlines | Lc 60 |
| Large text, at least `36pt` regular or `24pt` bold | Lc 45 |
| Fine-detail or outline icons | Lc 45 |
| Solid icons and UI components | Lc 30 |
| Non-text that only has to be discernible, such as dividers | Lc 15 |

Disabled and placeholder text are not covered by a requirement. Aim for Lc 30 so they stay legible.

Lc is signed. Positive means dark text on a light background, negative means light text on a dark background. Compare the absolute value against the threshold.

## Fix a failing pair only on request

**Change lightness first.** It is the channel contrast responds to. Hue and saturation move the measured value far less.

Move the foreground away from the background in perceived lightness, holding hue and saturation, then remeasure. Keeping hue fixed is what stops a contrast fix becoming a palette change.

| Pair | Text | Background | Lc |
| --- | --- | --- | --- |
| Failing: text too close to its background in lightness | `#7d93b0` | `#eef2f7` | ≈ 50 |
| Fixed: darker text, same hue | `#2b3a4f` | `#eef2f7` | ≈ 88 |

Two constraints on the fix:

- **Mid-lightness backgrounds cap what is achievable.** On a background near OKLCH `L` `0.75`, even pure black text reaches only about Lc 60. Body text needs a background near one extreme, so a mid-range background is the thing that has to change.
- **Pushing lightness can push the color out of gamut.** Reduce saturation as needed to keep it renderable. See [color-formats.md](color-formats.md).

Always remeasure after changing a value. Do not assume a fix landed.

## Pick text polarity from the background

Compare black and white using the project's required contrast metric. APCA and WCAG 2 can favor different text colors on the same background. A higher score does not by itself mean the pair passes.

WCAG 2's neutral crossover is near 56% OKLCH lightness. At `oklch(65% 0 0)`, black measures about `6.49:1` and white `3.23:1`. Only black passes AA for normal text. For colored backgrounds or other foregrounds, measure the actual pair rather than applying a crossover.

## What to check

- **Every pair, in every appearance.** APCA scores mirrored pairs differently, so a pair passing in light mode can fail in dark.
- **Translucent surfaces.** A color on a blurred translucent header (**Web:** `backdrop-filter`; Apple materials and Liquid Glass) or an overlay shifts with whatever scrolls behind it. Test against the lightest and darkest content it can sit over, or make the surface opaque enough that the shift cannot break the pair.
- **Computed colors.** Mixes, relative adjustments and opacity resolve at render time; measure the rendered result, not the declaration.
- **Text over images.** There is no single background color. Measure the worst region, or guarantee one with a scrim.
