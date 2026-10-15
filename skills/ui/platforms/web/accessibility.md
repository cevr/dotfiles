# Accessibility on the web

HTML, CSS, ARIA and DOM implementation of [accessibility](../../references/accessibility/index.md). Each section adds the how to the neutral rule it links; the rule and its reason live there. Element choice, landmarks, accessible names and ARIA rules are in [semantics-and-aria.md](semantics-and-aria.md).

## Focus and keyboard

### Focus rings

Rule: [focus rings](../../references/accessibility/focus-and-keyboard.md#focus-rings). The browser shows `:focus-visible` for keyboard and assistive-tech focus, suppresses it for mouse clicks on buttons and links, and still shows it in text inputs. An `outline: none` or `focus:outline-none` with no visible replacement removes it. A custom `outline: 2px solid` with no color renders `currentColor`.

```css
/* Best: keep the browser ring, just give it breathing room */
:focus-visible {
  outline-offset: 2px;
}

/* Custom ring when the design requires one: use the project's verified token */
:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
```

```tsx
// Tailwind: use the project's focus token or established focus-ring utility
<button className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]">
  Save
</button>
```

In `forced-colors: active` (Windows High Contrast), keep the default color adjustment or name a system color such as `Highlight`. `forced-color-adjust: none` freezes the authored color, so use it only where you have checked the control stays perceivable.

Group focus styles with `:focus-within` when a wrapper should light up while an inner input has focus.

### Skip link

Rule: [bypass blocks](../../references/accessibility/focus-and-keyboard.md#bypass-blocks). Target `<main id="main">` and visually hide the link until focused:

```css
.skip-link {
  position: absolute;
  inset-inline-start: -999px;
}
.skip-link:focus {
  inset-inline-start: 16px;
  inset-block-start: 16px;
}
```

```html
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header>…</header>
  <main id="main">…</main>
</body>
```

Give in-page anchor targets `scroll-margin-top`, such as `80px` under a sticky header, so the target isn't hidden when jumped to.

### tabindex

Rule: [focus order](../../references/accessibility/focus-and-keyboard.md#focus-order).

- `tabindex="0"`: adds an element to the natural tab order. Only for custom interactive elements that aren't natively focusable.
- `tabindex="-1"`: focusable via JavaScript only (`el.focus()`). Use for headings you move focus to, modal containers and roving-tabindex members.
- Positive `tabindex`: never. It hijacks the tab order for the whole page. Fix the DOM order instead.

Roving tabindex: in a composite widget the active item has `tabindex="0"`, all others `tabindex="-1"`, and arrow keys move both focus and the `0`:

```tsx
<div role="tablist">
  {tabs.map((tab, i) => (
    <button
      role="tab"
      tabIndex={i === activeIndex ? 0 : -1}
      aria-selected={i === activeIndex}
      onKeyDown={handleArrowKeys} // ArrowLeft/ArrowRight move activeIndex, wrapping
    >
      {tab.label}
    </button>
  ))}
</div>
```

A combobox keeps DOM focus in its input instead. Point `aria-activedescendant` on the input at the `id` of the highlighted option and update it on arrow keys.

### Dialogs

Rule: [focus trapping and restoration](../../references/accessibility/focus-and-keyboard.md#focus-trapping-and-restoration). Native `<dialog>` with `showModal()` makes everything behind it inert and closes on Escape:

```tsx
dialogRef.current.showModal(); // on open
dialogRef.current.close(); // on close
triggerRef.current?.focus(); // return focus to the element that opened it
```

A custom overlay that can't use `<dialog>` needs `role="dialog"`, `aria-modal="true"` and an accessible name via `aria-labelledby`. Put `inert` on everything behind it, which removes background content from the tab order and from assistive tech in one move:

```tsx
// On open
document.getElementById("app-content").inert = true;
const dialog = dialogRef.current;
(dialog.querySelector("[autofocus]") ??
  dialog.querySelector("button, [href], input, select, textarea"))?.focus();

// On close
document.getElementById("app-content").inert = false;
triggerRef.current?.focus();
```

### Keyboard patterns

The [key maps](../../references/accessibility/focus-and-keyboard.md#keyboard-patterns) are the ARIA Authoring Practices Guide (APG) patterns. A disclosure or accordion header is a `<button aria-expanded>`. Enter in a single-line `<input>` submits its form natively; in `<textarea>` it inserts a newline. A `role="button"` or `role="tab"` with no key handler fails them.

## Forms

### Labels

Rule: [labels](../../references/accessibility/forms.md#labels).

```html
<!-- Good: explicit association -->
<label for="email">Email</label>
<input id="email" type="email" autocomplete="email" />

<!-- Good: wrapping label, so label and control share one hit target -->
<label>
  <input type="checkbox" /> Send me updates
</label>
```

Required fields take native `required` plus the visible indicator.

### Error markup

Rule: [error messaging](../../references/accessibility/forms.md#error-messaging).

```html
<label for="email">Email</label>
<input
  id="email"
  type="email"
  autocomplete="email"
  aria-invalid="true"
  aria-describedby="email-error"
/>
<p id="email-error">Enter a valid email address.</p>
```

Remove `aria-invalid` once the field is fixed.

### Autocomplete and input types

Rule: [autofill and keyboards](../../references/accessibility/forms.md#autofill-and-keyboards). Pair a valid `autocomplete` token with a descriptive `name` attribute, a real `<form>` and no fake inputs.

| Field | `autocomplete` |
| --- | --- |
| Name | `name` (or `given-name` / `family-name`) |
| Email | `email` |
| Phone | `tel` |
| Address | `street-address`, `address-line1`, `postal-code`, `country` |
| Card | `cc-number`, `cc-exp`, `cc-csc`, `cc-name` |
| Login | `username`, `current-password` |
| Signup / reset | `username`, `new-password` |
| 2FA code | `one-time-code` |

Prefix with a section where relevant: `autocomplete="shipping street-address"`.

| Input | Use |
| --- | --- |
| Email, URL, phone | `type="email"`, `type="url"`, `type="tel"` |
| OTP / PIN / card number | `type="text" inputmode="numeric"` (keeps text semantics, no spinner) |
| Money, decimals | `type="text" inputmode="decimal"` |
| True numeric quantity | `type="number"` |

On emails, codes and usernames: `spellcheck="false"`, `autocapitalize="none"`, `autocorrect="off"`. Set `enterkeyhint="send"`, `"search"` or `"done"` for the return key.

### Pending submit

Rule: [submit behavior](../../references/accessibility/forms.md#submit-behavior). Mark the pending button `aria-disabled="true"` and ignore repeat clicks in the handler. Native `disabled` on the focused button drops focus to `<body>`.

## Screen readers

### Visually hidden content

Rule: [visually hidden content](../../references/accessibility/screen-readers.md#visually-hidden-content). The canonical `.sr-only` pattern hides content visually while keeping it in the accessibility tree:

```css
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
```

Use `1px` boxes, not `0`, because some screen readers skip zero-sized elements. `white-space: nowrap` stops words being read as one run-together string. Never `display: none` or `visibility: hidden`, which remove the content from assistive tech entirely. Tailwind ships this as `sr-only`: `<span class="sr-only">Opens in new tab</span>`.

### Live regions

Rule: [live regions](../../references/accessibility/screen-readers.md#live-regions).

| Mechanism | Politeness | Use for |
| --- | --- | --- |
| `role="status"` (= `aria-live="polite"` + `aria-atomic="true"`) | Waits for a pause | Toasts, "Saved", result counts, loading updates |
| `role="alert"` (= `aria-live="assertive"` + `aria-atomic="true"`) | Interrupts immediately | Errors and urgent problems only |

A field-tied message uses `aria-describedby` on the control instead.

```tsx
// Region rendered from the start, message injected later
<div role="status" className="sr-only">
  {statusMessage}
</div>
```

For loading states, set `aria-busy="true"` on the updating region while it changes.

### SVG

Rule: [alt text](../../references/accessibility/screen-readers.md#alt-text). Decorative images get `alt=""`, empty but present; a missing `alt` makes screen readers read the file name.

- Decorative SVG: `aria-hidden="true"`. No title needed.
- Meaningful inline SVG: `role="img"` plus `aria-label="…"`, or a `<title>` as the first child referenced by `aria-labelledby`.
- Simple cases: `<img src="icon.svg" alt="…">` is the most reliable delivery.

```tsx
// Decorative icon inside a labeled button
<button aria-label="Close">
  <svg aria-hidden="true">…</svg>
</button>

// Standalone meaningful icon
<svg role="img" aria-label="Verified account">…</svg>
```

## Hit areas

### Expanding the hit area

Rule: [expanding the hit area](../../references/accessibility/hit-areas.md#expanding-the-hit-area). Extend with a pseudo-element on a wrapping element or the `<button>`, never on the `<input>`, because form controls don't render `::before`/`::after` reliably.

```css
/* 20px checkbox with a 44px hit area, on the wrapper around the input */
.checkbox-control {
  position: relative;
  width: 20px;
  height: 20px;
}

.checkbox-control::after {
  content: "";
  position: absolute;
  top: 50%;
  left: 50%; /* physical centering: direction-independent */
  transform: translate(-50%, -50%);
  width: 44px;
  height: 44px;
}
```

```tsx
<button
  aria-label="Mark done"
  className="relative size-5 after:absolute after:top-1/2 after:left-1/2 after:size-11 after:-translate-1/2"
>
  <CheckIcon aria-hidden="true" />
</button>
```

Layout alternative, where the element can afford real box size:

```css
.icon-button {
  min-width: 44px;
  min-height: 44px;
  display: inline-grid;
  place-items: center;
}
```

A decorative layer over controls takes `pointer-events: none` ([decorative layers](../../references/accessibility/hit-areas.md#decorative-layers)):

```css
.card-glow {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
```

## Motion and zoom

### prefers-reduced-motion

Rule: [reduced motion](../../references/accessibility/motion-and-zoom.md#reduced-motion).

```css
/* Good: motion is opt-in */
.card {
  /* static styles */
}
@media (prefers-reduced-motion: no-preference) {
  .card {
    transition: transform 200ms ease-out;
  }
}
```

```tsx
// Tailwind: motion-safe / motion-reduce variants
<div className="motion-safe:transition-transform motion-safe:hover:-translate-y-1" />
```

### Zoom and reflow

Rule: [zoom and reflow](../../references/accessibility/motion-and-zoom.md#zoom-and-reflow). Reflow is tested at 400% zoom on a 1280px viewport, equivalent to a 320 CSS px one. Write media queries in `rem` or `em` where the codebase allows: at a larger browser font size such a query switches to the narrow layout when the text needs it, and a `px` query does not. Text containers take `min-height`, not `height`. Never set `maximum-scale=1` or `user-scalable=no` in the viewport meta; iOS input zoom is fixed with the [16px input rule](typography.md#ios-input-zoom).

## Before you finish

| Pattern | Fix |
| --- | --- |
| `outline: none` or `outline-none` with no `focus-visible` replacement nearby | Restore the browser ring or add a verified custom one |
| `<div onClick` or `<span onClick` | Use `<button>`, or `<a href>` when it navigates |
| `role="button"` or `role="tab"` with no `onKeyDown` | Use the native element, or implement the APG key map |
| `tabIndex={1}` or any positive `tabindex` | Fix the DOM order and use `0` |
| `disabled={!isValid}` on a submit button | Keep it enabled and validate on submit |
| `{msg && <div role="status">`, region mounted with its text | Render the empty region first and update its text |
| `aria-live="assertive"` on a success toast | `role="status"` |
| `<img` with no `alt` attribute | `alt=""` if decorative, otherwise describe the purpose |
| `aria-label` whose text omits the visible label | Start the name with the visible text |
| `aria-hidden` on an ancestor of a button, link or input | Remove it, or make the subtree inert |
| `maximum-scale=1` or `user-scalable=no` | Remove it |
| `position: sticky` header with no `scroll-padding-top` on the scroller | Pad the scroller by the header height |
| Tooltip on a natively `disabled` control | Text beside it, or `aria-disabled` so it stays focusable |
| `onDragStart` or a drag library with no button alternative | Add a single-pointer path to the same result |

## Verify

Without a browser: accessible names on every interactive element, keyboard handlers on non-native controls, focus styles, `prefers-reduced-motion` guards and form labels bound to their inputs. With one: tab the flow in order, read computed names and roles from the accessibility tree in devtools, confirm a visible focus indicator at every stop, run an automated audit (axe or Lighthouse), check 200% zoom and a 320px-wide viewport, and listen with a screen reader (VoiceOver on macOS).
