// A transcript line that opens a session on click: a subagent's row, a
// finished worker's notice. It reads as plain text until the pointer is over
// it, then brightens.
import { createSignal, type Accessor } from "solid-js"
import type { Host } from "./host.ts"

/**
 * Pointer handlers for a box that opens `sessionID` (when there is one) on
 * click, and whether the pointer is over it. A drag that selected text is a
 * copy, not a click.
 */
export function useSessionLink(host: Host, sessionID: Accessor<string | undefined>) {
  const [over, setOver] = createSignal(false)
  return {
    hover: () => over() && sessionID() !== undefined,
    handlers: {
      onMouseOver: () => setOver(true),
      onMouseOut: () => setOver(false),
      onMouseUp: () => {
        if (host.selecting()) return
        const id = sessionID()
        if (id) host.open(id)
      },
    },
  }
}
