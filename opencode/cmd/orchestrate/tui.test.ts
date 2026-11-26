// The TUI half's seam: the draft reporter on a stand-in TUI. A key or a
// paste makes it look at the root on screen and the focused editor's text,
// and it reports a draft to that root over the idle RPC, its end, and a move
// to another root; a subagent's screen reports to its root; the cleanup
// stops it listening.
import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { IDLE } from "@dotfiles/opencode-orchestrate/idle"
import { type Host, report } from "./tui.ts"

const tui = () => {
  const keys = new EventEmitter()
  const sent: Array<{ readonly id: string; readonly input: unknown; readonly location: unknown }> = []
  const screen = { route: { type: "home" } as { readonly type: string; readonly sessionID?: string }, text: "" }
  const location = { directory: "/work" } as unknown as Host["location"]
  const host: Host = {
    location,
    renderer: { keyInput: keys, get currentFocusedEditor() { return { plainText: screen.text } } },
    ui: { router: { current: () => screen.route } },
    data: { session: { root: (sessionID: string) => (sessionID === "child" ? "root" : sessionID) } },
    client: {
      rpc: (definition) => ({
        draft: (input, options) => {
          sent.push({ id: definition.id, input, location: options.location })
          return Promise.resolve({ ok: true })
        },
      }),
    },
  }
  const deferred: Array<() => void> = []
  const stop = report(host, "tui-1", () => 1_000, (look) => { deferred.push(look) })
  /** Deliver the key, then the scheduled read, in that order. */
  const press = (event: "keypress" | "paste" = "keypress") => {
    keys.emit(event)
    for (const look of deferred.splice(0)) look()
  }
  return { sent, screen, location, press, stop }
}

test("a draft to the root on screen is reported once, then its end; a subagent's screen reports to its root", () => {
  const { sent, screen, location, press, stop } = tui()
  press()
  expect(sent).toEqual([])
  screen.route = { type: "session", sessionID: "child" }
  screen.text = "h"
  press()
  screen.text = "hi"
  press("paste")
  screen.text = ""
  press()
  expect(sent).toEqual([
    { id: IDLE.id, input: { sessionID: "root", drafting: true, client: "tui-1" }, location },
    { id: IDLE.id, input: { sessionID: "root", drafting: false, client: "tui-1" }, location },
  ])
  stop()
})

test("moving to another root with a draft moves the report; after the cleanup, keys report nothing", () => {
  const { sent, screen, press, stop } = tui()
  screen.route = { type: "session", sessionID: "root" }
  screen.text = "draft"
  press()
  screen.route = { type: "session", sessionID: "other" }
  press()
  expect(sent.map((report) => report.input)).toEqual([
    { sessionID: "root", drafting: true, client: "tui-1" },
    { sessionID: "root", drafting: false, client: "tui-1" },
    { sessionID: "other", drafting: true, client: "tui-1" },
  ])
  stop()
  screen.text = ""
  press()
  expect(sent).toHaveLength(3)
})
