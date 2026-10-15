# Forms

Labels, error messaging, autofill and keyboards, submit behavior.

Implementation: [web](../../platforms/web/accessibility.md#forms) · [Apple](../../platforms/apple/accessibility.md#forms) · [Android](../../platforms/android/accessibility.md#forms)

## Labels

Every control needs a visible label programmatically tied to it, so assistive tech reads the label with the control. A placeholder disappears the moment the user types and usually fails contrast, so it never stands in for a label.

Label and control share one hit target: tapping "Send me updates" toggles its checkbox, with no dead zone between them. Mark required fields with the platform's required state plus a visible indicator explained once per form ("* required").

**Web:** `<label for>` pointing at the input's `id`, or a wrapping `<label>`; markup in the [web file](../../platforms/web/accessibility.md#labels).

## Error messaging

- The failing field is marked invalid, and the mark clears once it is fixed.
- The field is linked to its inline error, so screen readers announce the error with the field.
- Errors render inline beside their fields, with an icon or text. Never a red border alone, which is a color-only cue.
- On submit, focus the first invalid field.
- Accept free text and validate after. Never block typing or filter characters as the user types. Trim values before validating, because autocomplete and text expansion add trailing spaces.

**Web:** `aria-invalid="true"` plus `aria-describedby` pointing at the error's `id`; the complete pattern is in the [web file](../../platforms/web/accessibility.md#error-markup).

## Autofill and keyboards

A field collecting information about the user declares its content type (1.3.5): name, email, phone, address, card details, username, current password versus new password, one-time code. Password managers, contact autofill and SMS-code autofill depend on it, and on a real form with no fake inputs. Each platform's token list is in its file.

The field's type summons the right keyboard:

| Input | Keyboard |
| --- | --- |
| Email, URL, phone | The email, URL and phone keyboards |
| OTP / PIN / card number | Numeric keypad, keeping text semantics (no spinner, leading zeros kept) |
| Money, decimals | Decimal keypad |
| True numeric quantity | A number field |

Turn off spellcheck, autocapitalization and autocorrect on emails, codes and usernames, so the keyboard doesn't capitalize or "fix" them.

Label the return key with what it does: send, search, next, done.

The input's font size decides whether iOS Safari zooms the page on focus; that fix is in [typography](../../platforms/web/typography.md#ios-input-zoom).

## Submit behavior

- Keep submit enabled until the request starts. While it runs, show a spinner *beside the original label*: "Save" with a spinner, not a bare spinner. The label is what tells assistive tech which button is busy.
- The pending button stays focusable and announces itself as unavailable; ignore repeat presses in the handler. Disabling the focused button outright drops focus to the top of the page on the web. **Web:** `aria-disabled="true"`, not native `disabled`.
- Announce results. Success goes through a polite announcement. On failure, focus the first invalid field, which is itself the announcement. Reserve an assertive announcement for form-level errors not tied to a field ([screen-readers.md](screen-readers.md#choosing-how-to-announce-a-change)).
- Warn on unsaved changes before navigation. A re-render (or hydration on the web) must never reset a field's typed value or move focus out of it.
