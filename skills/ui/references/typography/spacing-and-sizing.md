# Spacing and sizing

A starting type scale, the heading mapping and line-height for wrapping text. Units and text trimming are platform mechanics: [web](../../platforms/web/typography.md#units) · [Apple](../../platforms/apple/typography.md) · [Android](../../platforms/android/typography.md).

## Type scale

Pick an existing scale or define one. A starting point for a product interface, named by role:

| Role | Size | Line-height | Weight |
| --- | --- | --- | --- |
| Display | `36pt` | `1.1` | `600` |
| Title | `24pt` | `1.2` | `600` |
| Heading | `18pt` | `1.3` | `600` |
| Body | `16pt` | `1.5` | `400` |
| Caption | `13pt` | `1.4` | `400` |

Emphasis within a role is one weight step up (`400` → `500`), not a size change.

Platform scales are already role-named and replace this table on their platform: Apple's text styles and Material 3's type scale. The web form, as `rem` custom properties, is in [web typography](../../platforms/web/typography.md#type-scale).

## Heading hierarchy

| Level | Role |
| --- | --- |
| 1 | Display |
| 2 | Title |
| 3 | Heading |

Deeper levels share Heading and stay distinct through weight or letter-spacing. Centralize the level-to-role mapping in one place, a heading component or base style, rather than repeating it at every heading.

## Line-height for wrapping text

A card description that wraps to three lines reads as body text, so it takes body leading:

| Text | Line-height |
| --- | --- |
| Card description at heading leading (bad) | `1.1` |
| Card description that wraps to 3 lines (good) | `1.4` |
