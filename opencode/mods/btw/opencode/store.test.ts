// SideQuestions over a stand-in for the TUI's durable storage entry, which
// behaves as the host's does (packages/tui/src/context/storage.tsx): a write
// runs the mutation on a JSON copy of the stored value and then replaces it,
// and a write that fails leaves the value as it was.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { sideQuestionsLaws } from "../laws.ts"
import { SideQuestions } from "../service.ts"
import { INITIAL } from "../side-question.ts"
import { EMPTY, type Entry, layer, SESSIONS_KEPT, stateOf, type Stored } from "./store.ts"

const entry = (initial: Stored = EMPTY, refusing = false): Entry & { readonly value: () => Stored } => {
  let value: Stored = structuredClone(initial)
  return {
    value: () => value,
    read: () => value,
    write: async (mutation) => {
      if (refusing) throw new Error("disk full")
      const draft: Stored = JSON.parse(JSON.stringify(value))
      mutation(draft)
      value = draft
    },
  }
}

sideQuestionsLaws(
  "OpenCode's SideQuestions",
  Effect.sync(() => layer(entry())),
)

const fork = { sessionID: "ses_fork", name: "btw: why", createdAt: 5, broughtBack: [] }

describe("OpenCode's SideQuestions", () => {
  test("a stored state that does not decode reads as the initial state", () => {
    expect(stateOf({ sessions: { main: { fork: { sessionID: 3 } } } }, "main")).toEqual(INITIAL)
    expect(stateOf({ sessions: { main: "junk" } }, "main")).toEqual(INITIAL)
  })

  test(`keeps the ${SESSIONS_KEPT} sessions written last`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const stored = entry()
        const store = yield* SideQuestions.pipe(Effect.provide(layer(stored)))
        for (let index = 0; index <= SESSIONS_KEPT; index++) yield* store.set(`ses_${index}`, { fork })
        // Writing the oldest again makes it the newest.
        yield* store.set("ses_1", { fork })
        yield* store.set("ses_new", { fork })
        const ids = Object.keys(stored.value().sessions)
        expect(ids.length).toBe(SESSIONS_KEPT)
        expect(ids.includes("ses_0")).toBe(false)
        expect(ids.includes("ses_2")).toBe(false)
        expect(ids.slice(-2)).toEqual(["ses_1", "ses_new"])
      }),
    ))

  test("a write the storage refuses fails HostFailed and keeps what was stored", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const stored = entry({ sessions: {} }, true)
        const failure = yield* SideQuestions.use((store) => Effect.flip(store.set("main", { fork }))).pipe(Effect.provide(layer(stored)))
        expect([failure._tag, failure.operation, failure.message]).toEqual(["HostFailed", "store", "disk full"])
        expect(stored.value()).toEqual({ sessions: {} })
      }),
    ))
})
