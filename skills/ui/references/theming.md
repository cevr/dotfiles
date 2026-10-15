# Theming and Tokens

How UI work stays inside a project's design system: where values live, how components consume them, and how to change them. For applying a brand spec or building a design system page, see [design-system.md](design-system.md).

Implementation: [web](../platforms/web/theming.md) · [Apple](../platforms/apple/theming.md) · [Android](../platforms/android/theming.md)

## Find the System First

Before choosing a style, locate:

- **Token definitions**: where the theme's colors, type, spacing, radii, shadows, and motion values are declared. The platform file names the usual places.
- **Mode mechanism**: how light, dark, and high-contrast values are selected, and who owns the switch (the system setting, an in-app preference, or both).
- **Shared components**: the project's wrappers around its component library or system controls, their variants, and how they express state.
- **A nearby example** of the UI being requested.

Read actual declarations before using an unfamiliar token name. After deliberate local customization, the app's live definitions win over any reference snapshot, spec, or library default.

## Define Once, Reference Everywhere

- Literal values (hex, pt, ms, shadow geometry) live only in token definitions. Components and screens consume named references.
- Keep every mode's value together in the definition; never patch one mode at a use site with a mode-conditional override.
- A computed value copied into source (`15.29` standing in for a spacing token) is a hardcoded override: it stops tracking the theme.
- Typography is a bundle: font role, weight, size, line height, letter spacing. Apply the matching set; never pick a size and invent a line height.
- Structural choices are application decisions, not tokens: grid tracks, breakpoints, content max-widths, aspect ratios, positioning.
- A helper or alias (a utility class, a static color member, a theme accessor) is fine when it resolves to the theme. Trace it before replacing it. Don't add a parallel palette or aliases that hide arbitrary values.

## Color by Role, Not Palette

Use semantic roles paired with their foreground: primary with on-primary, muted with muted-foreground, destructive for errors. A raw palette value (a fixed blue, a named system hue, a hex literal) bypasses the theme and breaks in the other mode. Status (success, warning, error) uses the theme's status roles or a component variant. A categorical chart series is not a status just because its hue resembles one. Building ramps, naming tokens, and measuring contrast: [color](color/index.md).

## Use the Existing Vocabulary

Finish a screen with the colors, text steps, spacing steps, radii, shadows, and motion values the theme already has. When nothing fits, name the gap rather than inventing a value. For a single element, prefer another existing token or a component variant. Change a shared token only when the user asks for a theme change, then state the affected scope: one token edit reaches every consumer.

## Customizing a Component Library

A component library (the project's own, a third-party library, or the platform's system controls) is themed at the source, not at each call site:

1. **Theme values** for color, radius, shadow, and font.
2. **Built-in variants and sizes** the component already offers.
3. **A new variant** defined once in the component or style source when the design has a distinct recipe.
4. **A wrapper component** for a recurring composition.

Call-site styling handles layout (width, placement, margins), not color or typography. Unchanged library defaults are not an intentional design decision; a library in default state means the theme was never applied.

Keep the component's anatomy, accessibility behavior, and state handling. Replacing the component library is a separate migration, never a prerequisite for theming. Don't assume matching token names produce the same look across libraries; dimensions, state treatments, and edges may need explicit adaptation.

## Overlays Carry the Theme

An overlay can render outside the subtree that holds the theme: a portal, a separate window, a new hosting root. It then loses the theme's font, colors, custom tokens, or mode. Route every popover, menu, toast, sheet, and dialog through the app's themed container, or re-apply the theme at the overlay's root. Each platform file names which overlays inherit and which start fresh.

## States Are Distinct

Map hover, focus, pressed, selected, checked, disabled, read-only, invalid, loading, and complete separately. They are not interchangeable opacity treatments. Keep a real keyboard focus indicator alongside any selected or pressed style. Mark validation on the control itself, so assistive technology and styling read the same state.

## Motion Tokens

Use the theme's duration and easing tokens; controls and small popovers use the short curve, dialogs, drawers, and sheets the long one. Honor the reduced-motion setting, and keep the component's own present and dismiss lifecycle rather than adding a competing removal timer. Choosing curves, durations, and springs: [motion](motion/index.md).

## Mode Edges the Theme Doesn't Reach

Some surfaces render before the theme loads or outside it: system-drawn controls, the launch screen or first paint, the app icon or favicon, system bars, and values computed on one side of a server/client or process boundary. Give each one explicit values for every mode, set where the system reads them. The platform file lists that platform's edges.

## Troubleshooting

| Symptom | First checks |
| --- | --- |
| Theme missing on a screen | Tokens defined and loaded in the active scope |
| Overlay has a different font or mode | Whether the overlay renders inside the themed scope ([overlays](#overlays-carry-the-theme)) |
| Theme edits don't reach components | Competing scopes, hardcoded values, stale aliases |
| One change restyles many controls | The shared token or component rule and its consumers |
| Font looks wrong | Font files cover the used weights; the family is registered and reaches the theme role |
| Layout shifts when a border appears | Reserve the edge (a transparent border or inset stroke) in every state |
| A flash of the wrong mode at launch | A [mode edge](#mode-edges-the-theme-doesnt-reach): the first paint's background isn't set per mode |
