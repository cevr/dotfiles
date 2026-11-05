// The session an OpenCode event is about. The TUI's events (packages/plugin/
// src/tui/context.ts, `Data.listen`) carry it as `data.sessionID`: every
// session.* event (a step, a text delta, a tool call, the execution's end)
// does; others carry none.

/** The `sessionID` of the event's data, when it has one. */
export const sessionOf = (event: unknown): string | undefined => {
  if (typeof event !== "object" || event === null || !("data" in event)) return undefined
  const data = event.data
  if (typeof data !== "object" || data === null || !("sessionID" in data)) return undefined
  return typeof data.sessionID === "string" ? data.sessionID : undefined
}
