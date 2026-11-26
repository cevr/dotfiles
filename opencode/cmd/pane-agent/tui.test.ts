import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { BindPaneRequest } from "@dotfiles/opencode-pane-agent/worker"
import { bindActivePane, type Host, type RouteState } from "./tui.ts"

const makeHost = (sessionID: Option.Option<string>) => {
  const bound: Array<BindPaneRequest> = []
  const host: Host = {
    location: { directory: "/nonexistent/repo" },
    ui: {
      router: {
        current: (): RouteState =>
          Option.match(sessionID, {
            onNone: (): RouteState => ({ type: "home" }),
            onSome: (id): RouteState => ({ type: "session", sessionID: id }),
          }),
      },
    },
    data: {
      session: { root: (id) => `root_${id}` },
      listen: () => () => {},
    },
    bindPane: (input) => {
      bound.push(input)
    },
  }
  return { host, bound }
}

describe("cmd/pane-agent TUI binder", () => {
  test("binds the active session root to REX_SESSION and REX_BLOCK when local", () => {
    const { host, bound } = makeHost(Option.some("ses_1"))
    const stop = bindActivePane(host, { rexSession: Option.some("session:a"), rexBlock: Option.some("block:b") }, [])
    expect(Option.isSome(stop)).toBe(true)
    expect(bound).toEqual([{ sessionID: "root_ses_1", rexSession: "session:a", rexBlock: "block:b" }])
    Option.map(stop, (cleanup) => cleanup())
  })

  test("does nothing when attached remotely (--server or attach) or outside Rex", () => {
    const remote = makeHost(Option.some("ses_1"))
    const env = { rexSession: Option.some("session:a"), rexBlock: Option.some("block:b") }
    expect(Option.isNone(bindActivePane(remote.host, env, ["--server", "http://host"]))).toBe(true)
    expect(Option.isNone(bindActivePane(remote.host, env, ["attach"]))).toBe(true)
    expect(Option.isNone(bindActivePane(remote.host, { rexSession: Option.none(), rexBlock: Option.none() }, []))).toBe(true)
    expect(remote.bound).toEqual([])
  })
})
