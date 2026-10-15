# Color usage

Deploying color once the system exists: meaning, emphasis, gradients and appearance variants. For picking values see [palette-generation.md](palette-generation.md), for naming them [token-naming.md](token-naming.md), for checking pairs [contrast.md](contrast.md).

Implementation: [web](../../platforms/web/color.md) · [Apple](../../platforms/apple/color.md) · [Android](../../platforms/android/color.md)

## One color, one meaning

Users read a near-miss in hue as a slightly different shade, not as a different color.

| Element | Bad | Good |
| --- | --- | --- |
| Link | `#3b82f6` | The accent text token |
| Decorative section title | `#4f8ef7`, a near-miss of the link blue | The primary text token; headings stay neutral |

Interactive elements own the accent. The rule runs both ways. A color must not be *absent* where its meaning occurs. If the accent means interactive, an interactive element rendered neutral is just as misleading.

## Use tokens in their role

A value that happens to work in two roles stops working in both at the next theme change. Two common borrowings:

- A separator token used as a caption's text color because it looked right.
- A secondary-text token used as a tag's background.

The role inventory in [token-naming.md](token-naming.md) is the list of roles a system needs.

## One colored action per view

| Button | Treatment |
| --- | --- |
| Save, the one primary action | Accent solid fill, on-accent text |
| Cancel | Secondary text, no fill |
| Duplicate, Export beside Save (bad) | Also accent-filled, so nothing is primary |

Selected states may use the accent on the glyph and label. An active tab or a checked segment is state, not emphasis.

## Gradients

**The interpolation space is a look, not a correctness setting.** Three are worth knowing, and the difference between them is most visible in the middle of the gradient:

| Space | Look |
| --- | --- |
| sRGB | The classic default. The midpoint darkens and mutes |
| Oklab | Even brightness across the transition. The best default |
| OKLCH | Travels around the hue wheel, staying vivid throughout |

Oklab and sRGB are **rectangular**, interpolating in a straight line through the color space. OKLCH is **polar**, interpolating the hue angle, so it arcs around the wheel through every hue between the stops. That is why it stays saturated and why it can produce hues nobody asked for. A blue-to-pink gradient routes through purple, which is either the look or a surprise.

**The gray dead zone is a rectangular-space problem.** Two hues on opposite sides of the wheel sit either side of the neutral axis. A straight line between them passes near gray, and the middle goes lifeless. Either switch to a polar space, which routes around the axis, or add a third stop between the two and keep the space you have.

With a polar space you also control which way it goes around: the shorter way, usually what you want, or the longer way, which sweeps most of the spectrum.

**Banding shows up on large areas.** A gradient spanning a hero with little contrast between its stops steps visibly on 8-bit displays. Widen the contrast, shrink the area or overlay a subtle noise texture.

**Keep text off gradients where you can.** Contrast varies continuously across one, so a single measurement does not describe it. Where text must sit on a gradient, measure the worst region rather than the average, or put a scrim behind it.

## Color across cultures

Where a color carries meaning in finance, status or alerts, verify the meaning holds in every locale you ship to. Chinese financial UIs show gains in red and losses in green, the reverse of English ones. Where the product ships to such markets, make gain and loss per-locale tokens rather than hardcoded values.

## Light, dark and increased contrast

When the product ships a dark appearance, every custom color needs a dark variant, derived per [palette-generation.md](palette-generation.md). Users who enable increased contrast expect visibly stronger differentiation in each appearance, so a custom color has four values:

| Appearance | Accent solid |
| --- | --- |
| Light | `blue-600` |
| Light, increased contrast | `blue-900` |
| Dark | `blue-400` |
| Dark, increased contrast | `blue-200` |

One increased-contrast value shared by both appearances darkens the color on a dark background too, lowering contrast there. The increased-contrast variant widens the gap to its background by at least `0.15` of OKLCH `L` over the default. Remeasure it, aiming for Lc 90 on body text. Widening the gap without remeasuring is not fixing it.
