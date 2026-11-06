// The recover model over the memory world, as cmd/recover/tui.tsx builds it
// over the TUI client and the filesystem: when it moves a session, where to,
// and when it leaves the session be.
import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { layer, world, type World } from "@dotfiles/opencode-recover/memory/world"
import { recover } from "@dotfiles/opencode-recover/model"

const run = (w: World, sessionID: string, current: string) => Effect.runPromiseExit(recover(sessionID, current).pipe(Effect.provide(layer(w))))

describe("recover", () => {
  test("moves a session whose directory is gone back to the newest earlier location", async () => {
    const w = world(["/repo", "/a"], { ses_1: [{ location: { directory: "/b" }, previous: { location: { directory: "/a" } } }, { location: { directory: "/a" }, previous: { location: { directory: "/repo" } } }] })
    const exit = await run(w, "ses_1", "/b")
    expect(exit).toEqual(Exit.succeed({ _tag: "Moved", target: { directory: "/a" } }))
    expect(w.moves).toEqual([{ sessionID: "ses_1", directory: "/a" }])
  })

  test("leaves a session whose directory exists alone", async () => {
    const w = world(["/b", "/a"], { ses_1: [{ location: { directory: "/b" }, previous: { location: { directory: "/a" } } }] })
    expect(await run(w, "ses_1", "/b")).toEqual(Exit.succeed({ _tag: "Present" }))
    expect(w.moves).toEqual([])
  })

  test("leaves a session with no surviving earlier location in place", async () => {
    const w = world([], { ses_1: [{ location: { directory: "/b" }, previous: { location: { directory: "/a" } } }] })
    expect(await run(w, "ses_1", "/b")).toEqual(Exit.succeed({ _tag: "Stranded" }))
    expect(w.moves).toEqual([])
  })

  test("fails with the host's refusal when the move is refused", async () => {
    const w = world(["/a"], { ses_1: [{ location: { directory: "/b" }, previous: { location: { directory: "/a" } } }] })
    w.refuse = "busy"
    const exit = await run(w, "ses_1", "/b")
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("MoveRefused")
  })
})
