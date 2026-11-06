import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Sessions } from "../service.ts"
import { layer, type Page } from "./sessions.ts"

const switched = (to: string, from?: string) => ({
  id: `msg_${to}`,
  type: "location-switched",
  location: { directory: to },
  ...(from ? { previous: { location: { directory: from } } } : {}),
})

describe("Sessions over the TUI client", () => {
  test("reads every page of location switches, newest first, skipping what does not decode", async () => {
    const pages: Record<string, Page> = {
      start: { data: [switched("/c", "/b"), { type: "location-switched" }], cursor: { next: "p2" } },
      p2: { data: [switched("/b", "/a")], cursor: { next: null } },
    }
    const asked: Array<unknown> = []
    const sessions = layer({
      messages: async (input) => {
        asked.push(input)
        return pages[input.cursor ?? "start"] ?? { data: [], cursor: {} }
      },
      move: async () => undefined,
    })
    const read = await Effect.runPromise(Sessions.use((s) => s.switches("ses_1")).pipe(Effect.provide(sessions)))
    expect(read).toEqual([
      { location: { directory: "/c" }, previous: { location: { directory: "/b" } } },
      { location: { directory: "/b" }, previous: { location: { directory: "/a" } } },
    ])
    expect(asked).toEqual([
      { sessionID: "ses_1", type: "location-switched", limit: 100, order: "desc" },
      { sessionID: "ses_1", type: "location-switched", limit: 100, cursor: "p2" },
    ])
  })

  test("a list that fails is SwitchesUnreadable, a refused move MoveRefused", async () => {
    const sessions = layer({
      messages: () => Promise.reject(new Error("down")),
      move: () => Promise.reject(new Error("Destination not found")),
    })
    const read = await Effect.runPromiseExit(Sessions.use((s) => s.switches("ses_1")).pipe(Effect.provide(sessions)))
    expect(JSON.stringify(read)).toContain("SwitchesUnreadable")
    const moved = await Effect.runPromiseExit(Sessions.use((s) => s.move("ses_1", "/a")).pipe(Effect.provide(sessions)))
    expect(Exit.isFailure(moved)).toBe(true)
    expect(JSON.stringify(moved)).toContain("Destination not found")
  })

  test("a move goes to the host with the session and directory", async () => {
    const moves: Array<unknown> = []
    const sessions = layer({ messages: async () => ({ data: [], cursor: {} }), move: async (input) => void moves.push(input) })
    await Effect.runPromise(Sessions.use((s) => s.move("ses_1", "/a")).pipe(Effect.provide(sessions)))
    expect(moves).toEqual([{ sessionID: "ses_1", directory: "/a" }])
  })
})
