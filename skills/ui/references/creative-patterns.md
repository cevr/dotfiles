# Creative Pattern Catalog

Searchable catalog of high-end UI patterns. Use as inspiration and implementation reference when building distinctive interfaces.

---

## Navigation Patterns

### Dock Magnification
macOS-style dock with scale-on-hover. Each icon scales up (1.5–2x) with neighbors scaling proportionally using `useMotionValue` + `useTransform`. Spring physics for snap-back. Works best with 5–9 items.

### Magnetic Button
Button whose label/icon subtly follows cursor within hit area. Track mouse position relative to button center, apply constrained `translate` via `useMotionValue`. Reset on mouse leave with spring. Keep displacement under 4–6px for subtlety.

### Gooey Menu
Radial or arc menu using SVG `feTurbulence`/`feGaussianBlur` filter for organic blob merging. Items animate outward on trigger. Filter applied to container, not individual items. Fallback: standard radial without filter.

### Dynamic Island
Pill-shaped container that morphs between states (notification → player → timer). Use `layout` + `layoutId` for smooth interpolation. Content crossfades with `AnimatePresence`. Fixed position, typically top-center.

### Radial Menu
Context menu arranged in a circle/arc around trigger point. Items at equal angular intervals. Cursor distance from center = selection. Show on long-press or right-click. Label appears on hover per item.

### Mega Menu
Full-width dropdown with columns, images, and featured content. Trigger on hover with prediction cone (diagonal movement tolerance). Dismiss delay 200–300ms. Use `grid` layout with named areas.

---

## Layout Patterns

### Bento Grid
Asymmetric grid with mixed-size cells (1x1, 2x1, 1x2, 2x2). Use CSS Grid with `grid-template-areas` or explicit row/col spans. Each cell is a self-contained card with its own content density. Key: vary sizes intentionally — no uniform grids.

**Bento 2.0 Architecture:**
- Container: CSS Grid with `auto-fill`/`minmax` for responsive reflow
- Cards: 5 archetypes — **Hero** (2x2, primary CTA), **Metric** (1x1, single stat + sparkline), **Showcase** (2x1, image/video + caption), **List** (1x2, scrollable vertical content), **Interactive** (any size, embedded widget/demo)
- Animation engine: stagger entrance by grid position (`delay = (row + col) * 50ms`), hover lifts card with layered shadow, content within cards animates independently
- Gap: consistent `gap` value (12–20px); rounded corners on cards match gap proportionality

### Masonry
Variable-height items in columns without row alignment. CSS `columns` for simple cases; JS layout (e.g., `react-masonry-css`) for dynamic content. Reflow on resize. Item order: left-to-right then top-to-bottom (not column-first).

### Split Screen Scroll
Two panels: one fixed/sticky, one scrolling. Use `position: sticky` on the anchored side. Content on scrolling side drives narrative. Works for comparisons, before/after, storytelling.

### Curtain Reveal
Sections that stack and reveal as you scroll, each "pulling" the previous up like a curtain. Use `position: sticky` with incrementing `top` values. Each section is full-viewport. Z-index ascending with scroll order.

---

## Card Patterns

### Parallax Tilt
Card tilts toward cursor on hover. Track mouse position relative to card center, map to `rotateX`/`rotateY` (max 10–15deg). Add `perspective: 1000px` on parent. Subtle shadow shift opposite to tilt direction. Use `useMotionValue` for smooth tracking.

### Spotlight Border
Gradient border that follows cursor position. Technique: pseudo-element with `radial-gradient` positioned at cursor coordinates. `pointer-events: none` on the effect layer. Semi-transparent background on card so gradient shows through border area.

### Holographic Foil
Iridescent shimmer effect on hover. Use `conic-gradient` with hue-rotating colors, positioned at cursor. Blend with `mix-blend-mode: overlay` or `color-dodge`. Animate hue rotation on mouse move. Subtle — opacity 0.3–0.5.

### Morphing Modal
Card expands into full modal using shared-element transition. Use `layoutId` on the card and modal to interpolate position/size. Content crossfades during transition. Background dims with `AnimatePresence`. Close reverses the animation.

---

## Scroll Animations

### Sticky Stack
Cards stack on top of each other as you scroll, each pinning at a slight offset. Use `position: sticky` with incrementing `top` values (e.g., 20px, 40px, 60px). Each card has ascending `z-index`. Scale down slightly as cards get "buried."

### Horizontal Scroll Hijack
Vertical scroll input drives horizontal movement of a panel. Use `scroll-snap-type: x mandatory` with `scroll-snap-align: start` on items. Or: track scroll position, apply `translateX` proportionally. Clear affordance that content scrolls horizontally.

### Zoom Parallax
Elements scale/translate at different rates as user scrolls, creating depth. Map `scrollY` to `scale`/`translateZ` per layer. Foreground moves faster, background slower. Use `useScroll` + `useTransform` from motion/react. Keep layers to 3–4 max.

### Scroll Progress Path
SVG path that draws itself as user scrolls. Use `stroke-dasharray` + `stroke-dashoffset` driven by scroll progress. `useScroll` with `scrollYProgress` mapped to dashoffset. Path should be meaningful (route, timeline, illustration outline).

---

## Gallery Patterns

### Coverflow
3D carousel where center item faces forward, neighbors rotate away. Use `perspective` on container, `rotateY` on items based on distance from center. Scale center item larger. Swipe/arrow navigation. 5–7 visible items.

### Accordion Slider
Panels expand on hover/click, compressing neighbors. Use `flex` with animated `flex-grow`/`flex-basis`. Expanded panel shows full content; collapsed show edge/title only. Smooth width transitions. Exactly one panel expanded at a time.

### Hover Image Trail
Cursor leaves a trail of images as it moves over a trigger area. Spawn image elements at cursor position with staggered fade-out. Use `useMotionValue` for cursor tracking. Pool and reuse DOM nodes (max 8–12 visible). Images from a predefined set.

---

## Typography Effects

### Kinetic Marquee
Infinitely scrolling text strip. Duplicate content for seamless loop. Use CSS `animation` with `translateX(-50%)` on doubled content. Pause on hover. Speed varies by importance (faster = ambient, slower = readable). `will-change: transform`.

### Text Mask Reveal
Text revealed through a mask/clip-path animation. Use `clip-path` or `background-clip: text` with animated gradient position. Trigger on scroll-into-view. Works best with large, bold headings. Fallback: simple fade-in.

### Text Scramble
Characters cycle through random glyphs before resolving to final text. Animate per-character with interval, resolving left-to-right. Use monospace or ensure character widths are stable. Duration: 500–1000ms total. Good for loading states or reveals.

### Circular Text
Text arranged along a circular path. Use SVG `<textPath>` on a `<circle>`-derived `<path>`. Optionally rotate with CSS animation. Size the circle so text doesn't overlap. Works for badges, decorative elements, loading states.

---

## Micro-Interactions

### Particle Explosion
Burst of particles from a point on click/action. Spawn 12–20 particles with random velocity vectors, apply gravity/friction, fade out over 400–800ms. Use `useMotionValue` per particle or CSS `@keyframes` with random `--angle`/`--distance` custom properties.

### Skeleton Shimmer
Loading placeholder with traveling highlight. Use `linear-gradient` with transparent → white → transparent, animated with `translateX` across the element. `animation-duration: 1.5–2s`, `infinite`. Match skeleton shape to actual content layout.

### Directional Hover
Overlay/highlight enters from the direction the cursor entered the element. Detect entry edge by comparing cursor position to element center at `mouseenter`. Animate overlay from that edge. Use `clip-path` or positioned overlay with directional `translate`.

### Ripple Click
Material-style ripple expanding from click point. Spawn circle at click coordinates, scale from 0 to cover element, fade out. Use `position: absolute` within `overflow: hidden` container. Duration 400–600ms. Color: semi-transparent current color.

### Mesh Gradient
Organic, multi-point gradient background. Use multiple overlapping `radial-gradient` layers or CSS `conic-gradient` with blur. Animate control points subtly for living feel. Keep movement slow (>10s cycle). Performance: single `background` property, no extra elements.
