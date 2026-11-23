// The server plugin's seam: started on a stand-in host over a stand-in
// environment (the server's own in OpenCode), it takes the pane's two
// variables out and leaves the rest, so a shell whose session no TUI set
// names no pane.
import { expect } from "bun:test"
import { Effect } from "effect"
import { effectTest } from "../../sim-tui/effect-test.ts"
import Rex, { make } from "./server.ts"
import { hangGuard } from "../../tests/hang-guard.ts"

type Host = Parameters<(typeof Rex)["effect"]>[0]

effectTest(
  "takes REX_SESSION and REX_BLOCK out of the server's environment, and nothing else",
  Effect.gen(function* () {
    const env = {
      PATH: "/usr/bin",
      REX_SESSION: "session:manna",
      REX_BLOCK: "block:manna",
      REX_SERVER: "unix:/tmp/rex.sock",
      REX_BIN_DIR: "/opt/rex",
    }
    const host: Host = Object.create(null)
    yield* make(env).effect(host)
    expect(Object.entries(env)).toEqual([
      ["PATH", "/usr/bin"],
      ["REX_SERVER", "unix:/tmp/rex.sock"],
      ["REX_BIN_DIR", "/opt/rex"],
    ])
  }),
  hangGuard("local-fixture"),
)
