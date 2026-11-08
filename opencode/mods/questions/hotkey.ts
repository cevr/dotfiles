// The key that opens the /answer form without typing /answer, and when it
// does. shift+← is also the composer's own key (OpenCode's
// `input.select.left`, which selects one character to the left), so the
// hotkey takes it only when that would select nothing: the composer is empty.
// Otherwise the key goes on to the composer.

/** The binding, as OpenCode's keymap reads it. */
export const HOTKEY = "shift+left"
/** The binding as the tray shows it. */
export const HOTKEY_LABEL = "shift+←"

/** What the hotkey sees when it is pressed. */
export interface Pressed {
  /** The session on screen, if a session is. */
  readonly sessionID: string | undefined
  /** How many questions that session's tray shows. */
  readonly open: number
  /** The text of the focused editor (the composer), if one has the focus. */
  readonly composer: string | undefined
}

/** The session whose questions the hotkey opens, or undefined when the key goes on to the composer. */
export const opens = (pressed: Pressed): string | undefined => {
  if (pressed.sessionID === undefined || pressed.open === 0) return undefined
  if (pressed.composer !== undefined && pressed.composer !== "") return undefined
  return pressed.sessionID
}
