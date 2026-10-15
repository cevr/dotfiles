# Hit areas

Target sizes, expanding hit areas without changing visual size, collision rules and drag alternatives.

Implementation: [web](../../platforms/web/accessibility.md#hit-areas) · [Apple](../../platforms/apple/accessibility.md#hit-areas) · [Android](../../platforms/android/accessibility.md#hit-areas)

## Target sizes

| Standard | Minimum |
| --- | --- |
| WCAG 2.5.8 (AA) | 24×24 pt, with exceptions |
| WCAG 2.5.5 (AAA) | 44×44 pt |
| Web heuristic | 44×44 on touch, 40×40 on desktop, where density permits |
| Apple HIG | 44×44 pt (iOS, iPadOS, watchOS); 28×28 pt on macOS; 60×60 pt on visionOS |
| Material Design | 48×48 dp |

The 2.5.8 row is the criterion a finding cites. The platform row is what to build to on that platform, and it replaces the web heuristic there.

Before reporting an undersized target, check the spacing, equivalent-control, inline, user-agent and essential exceptions.

Under the spacing exception, an undersized target passes when a 24 pt circle centered on its bounding box intersects no other target and no other undersized target's circle. In the simple case, 20 pt targets need a 4 pt gap.

The visible element can stay small; the hit area is what must be big. Anything that looks clickable must be clickable across its whole visual extent.

## Expanding the hit area

Where the visible element is smaller, say a 20×20 checkbox, extend the hit area around it without changing its drawn size. Where the element can afford a real box size, give it the minimum size and center the glyph instead: the box is the target, with no extension to maintain.

**Web:** a centered pseudo-element on the wrapper or `<button>`; CSS, Tailwind and the layout alternative are in the [web file](../../platforms/web/accessibility.md#expanding-the-hit-area).

## Collision rule

Where the extended hit area overlaps another interactive element, shrink the extension to the largest size that does not collide.

## Decorative layers

A decorative layer painted over interactive content absorbs every pointer event its box covers: a gradient scrim, a glow, a blurred sheen, a full-bleed overlay. The control underneath looks live and does nothing, and no hit-area sizing fixes it.

Make each one pass input through to the control below, and hide it from assistive tech. **Web:** `pointer-events: none` (Tailwind `pointer-events-none`), plus `aria-hidden="true"` when the layer is an element rather than a pseudo-element.

Keep input on any layer the user is meant to hit: a modal scrim that dismisses on tap is a control, not decoration.

## Gestures and dragging

- Every drag needs a single-pointer alternative under 2.5.7, such as move-up and move-down buttons on a sortable row, or a menu on a kanban card.
- Every multipoint or path-based gesture, such as a pinch or a swipe, needs a single-pointer alternative under 2.5.1.
- Assistive tech reaches the alternative as a named action on the element when no visible button fits.
- **Web:** a surface implementing its own pan, zoom or drag gestures claims those axes with `touch-action`, scoped to that surface. The values and their scoping rule are in [mobile web](../../platforms/web/mobile.md#9-carousel-scrolls-vertically).
