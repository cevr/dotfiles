# Focus and keyboard

Focus indicators, focus order, bypassing repeated chrome, overlays, view changes and keyboard patterns.

Implementation: [web](../../platforms/web/accessibility.md#focus-and-keyboard) · [Apple](../../platforms/apple/accessibility.md#focus-and-keyboard) · [Android](../../platforms/android/accessibility.md#focus-and-keyboard)

## Focus rings

Keyboard and assistive-tech focus is always visible (2.4.7). Platforms show the indicator for keyboard focus, suppress it when a pointer activates a button or link, and still show it in text inputs. Removing the indicator with no visible replacement leaves sighted keyboard users with no way to see where they are.

The platform's unmodified indicator adapts to platform and high-contrast settings without the author predicting every background. Adding only an offset preserves it. A custom indicator with no explicit color inherits the foreground color, which may fail against the colors it crosses. The preference order: the platform indicator, then the platform indicator with breathing room, then a custom indicator in the project's verified focus token.

Check the whole perimeter of a custom indicator against every adjacent color it crosses. That means component fills, page surfaces, images, gradients and hover and selected states. A token, brand color or inherited foreground color passes only when that rendered check does.

In high-contrast modes (Windows forced colors, Increase Contrast), keep the system's color adjustment or name a system color. Freezing the authored color is for controls you have checked stay perceivable.

A wrapper may light up while an inner input has focus, such as a search box with an icon inside the border.

**Web:** style `:focus-visible`, not bare `:focus`; `outline-offset: 2px` alone keeps the browser ring. Custom rings, Tailwind, `forced-colors` and `:focus-within` are in the [web file](../../platforms/web/accessibility.md#focus-rings).

## Focus not obscured

Sticky chrome hides whatever scrolls under it, including the element that just received focus (2.4.11). The scroll container reserves the sticky element's height: at the top for a header, at the bottom for a sticky footer or cookie banner. An in-page jump target keeps the same margin, so it isn't hidden when jumped to.

**Web:** `html { scroll-padding-top: 64px; }` (the header's height), `scroll-padding-bottom` for a footer, `scroll-margin-top` on anchored headings.

## Bypass blocks

When repeated navigation or chrome precedes the main content, keyboard and screen-reader users get a way past it (2.4.1). Headings and the platform's region or landmark structure let screen-reader users jump; a keyboard user needs a direct jump too. **Web:** a "Skip to content" link as the first focusable element, recipe in the [web file](../../platforms/web/accessibility.md#skip-link).

## Focus order

- Focus order follows reading order (2.4.3). Fix the order in the view structure. An explicit ordering value hijacks the order for the whole screen; reserve the platform's ordering override for layouts whose visual order cannot match the structure, such as a circular dial.
- A custom interactive element joins the focus order. A heading you move focus to, a modal container and the members of a composite widget take focus only programmatically.
- A composite widget (tabs, menus, toolbars, radio groups, listboxes) occupies one Tab stop. The active item holds the stop, and arrow keys move focus and the stop together.
- A combobox keeps focus in its text input and moves a highlighted option instead, which the input exposes to assistive tech as the active option.

**Web:** `tabindex` rules, roving tabindex and `aria-activedescendant` are in the [web file](../../platforms/web/accessibility.md#tabindex).

## Focus trapping and restoration

Prefer the platform's modal presentation (a native dialog, sheet or alert), which makes the background inert and dismisses on Escape or Back. A custom overlay rebuilds all of it: it is announced as a dialog with an accessible name from its title, everything behind it leaves both the focus order and the assistive-tech tree, and Escape (Back on Android) closes it.

Either way:

- On open, focus the first focusable element. For destructive confirmations, focus the least destructive action instead.
- On close, return focus to the trigger, or to the nearest logical container if the trigger is gone.

## Keyboard patterns

Native controls come with these behaviors; custom widgets must implement them. They match the ARIA APG on the web and the native controls on macOS and on iPadOS and Android with a hardware keyboard.

| Widget | Keys |
| --- | --- |
| Dialog | Tab/Shift+Tab cycle inside (wrap at ends); Escape closes |
| Tabs | Arrow keys move between tabs (wrapping); Tab exits to the panel; Home/End jump to first/last |
| Menu button | Enter/Space/ArrowDown opens and focuses first item; ArrowUp opens and focuses last; arrows navigate; Escape closes and refocuses the button |
| Disclosure / accordion | Header is a button exposing its expanded state; Enter and Space toggle |
| Combobox | ArrowDown opens/moves into the list; Enter accepts; Escape closes and returns to the input; typing filters |
| Listbox / radio group | Arrow keys move selection; one Tab stop for the whole group |

Universal rules:

- Escape dismisses whatever opened last: tooltip, then menu, then dialog.
- Tabs choose activation mode: automatic (panel switches on arrow focus) when panels render instantly, manual (Enter/Space to activate) when switching is expensive.
- Enter in a single-line text field submits its form. In a multi-line field, Enter inserts a newline, and ⌘/Ctrl+Enter submits only if you implement it.

## View changes

Moving to a new view updates the window or screen title to the new context and moves focus to the new view's heading or start. History traversal (back and forward) restores scroll position; a new navigation starts at the top. Native navigation stacks do this; client-side web routing does nothing on its own.

**Web:** on route change, set `document.title`, then focus the new view's `<h1>` (given `tabindex="-1"`) or `<main>`.
