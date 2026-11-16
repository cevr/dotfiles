// What the other plugins hold, over stand-ins for their RPCs: the laws, with
// each world answered as the wakes, the questions and the queue answer, and
// one plugin missing while the others answer.
import { expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { type Holds, NO_HOLDS } from "../idle.ts"
import { rootHoldsLaws } from "../laws.ts"
import { RootHolds } from "../service.ts"
import * as OpenCodeHolds from "./holds.ts"

/** The three RPCs answering `world`, as each plugin shapes its answer. */
const asks = (world: Readonly<Record<string, Holds>>): OpenCodeHolds.Asks => ({
  pending: ({ sessionIDs }) =>
    Effect.succeed({
      now: 0,
      notices: [],
      entries: sessionIDs.flatMap((sessionID) =>
        Array.from({ length: world[sessionID]?.wakes ?? 0 }, (_, n) => ({ id: `w${n}`, kind: "alarm", sessionID, mode: "wake", note: "n", dueAt: 1 })),
      ),
    }),
  open: ({ sessionIDs }) =>
    Effect.succeed({
      questions: sessionIDs.flatMap((sessionID) =>
        Array.from({ length: world[sessionID]?.questions ?? 0 }, (_, n) => ({ id: `q${n}`, sessionID, question: "?", assume: "a", askedAt: 1 })),
      ),
    }),
  queue: ({ sessionID }) => {
    const holds = world[sessionID] ?? NO_HOLDS
    const item = (state: string) => (named: string) => {
      const [, text, detail] = /^(.*?)(?: \((.*)\))?$/.exec(named) ?? []
      return { id: text, text, state, owner: "mine", ...(detail === undefined ? {} : { detail }) }
    }
    return Effect.succeed({
      revision: 1,
      items: [...holds.needsYou.map(item("needs-you")), ...holds.waits.map(item("waiting")), { id: "n", text: "Next thing", state: "next", owner: "mine" }],
    })
  },
  jobs: () => Effect.succeed({ now: 0, jobs: [] }),
})

const failing = () => Effect.fail(new Error("no server"))

rootHoldsLaws("OpenCode's RootHolds", (world) =>
  OpenCodeHolds.layer(world === "unreadable" ? { pending: failing, open: failing, queue: failing, jobs: failing } : asks(world)),
)

effectTest(
  "the ledger's holds are the root's queue not done, its wakes whole, and its jobs still running; a missing plugin holds none",
  Effect.gen(function* () {
    const shown: OpenCodeHolds.Asks = {
      ...asks({}),
      pending: () =>
        Effect.succeed({
          now: 0,
          notices: [],
          entries: [
            { id: "w1", kind: "monitor", sessionID: "root", mode: "wake", note: "CI on main", dueAt: 9 },
            { id: "w2", kind: "alarm", sessionID: "other", mode: "wake", note: "not ours", dueAt: 9 },
          ],
        }),
      queue: () =>
        Effect.succeed({
          revision: 1,
          items: [
            { id: "a", text: "Land alpha", state: "next", owner: "mine", detail: "after verify" },
            { id: "b", text: "Old", state: "done", owner: "mine" },
          ],
        }),
      jobs: () =>
        Effect.succeed({
          now: 0,
          jobs: [
            { id: "j1", sessionID: "root", note: "", command: "bun run gate", cwd: "/w", setAt: 1, state: "running", logTail: "" },
            { id: "j2", sessionID: "root", note: "old", command: "true", cwd: "/w", setAt: 1, state: "exited", exitCode: 0, logTail: "" },
          ],
        }),
    }
    const heldOf = (given: OpenCodeHolds.Asks) => RootHolds.use((holds) => holds.held("root")).pipe(Effect.provide(OpenCodeHolds.layer(given)))
    expect(yield* heldOf(shown)).toEqual({
      queue: [{ text: "Land alpha", state: "next", detail: Option.some("after verify") }],
      wakes: [{ kind: "monitor", note: "CI on main", dueAt: 9 }],
      jobs: [{ note: "bun run gate", state: "running" }],
    })
    expect(yield* heldOf({ pending: failing, open: failing, queue: failing, jobs: failing })).toEqual({ queue: [], wakes: [], jobs: [] })
  }),
  5_000,
)

test("a plugin that is missing holds nothing, and the others still answer", async () => {
  const world = { root: { wakes: 1, questions: 2, needsYou: [], waits: ["owner review"] } }
  const holdsOf = (layer: ReturnType<typeof OpenCodeHolds.layer>) => Effect.runPromise(RootHolds.use((holds) => holds.of("root")).pipe(Effect.provide(layer)))
  expect(await holdsOf(OpenCodeHolds.layer({ ...asks(world), pending: failing }))).toEqual({ ...world.root, wakes: 0 })
  expect(await holdsOf(OpenCodeHolds.layer({ ...asks(world), open: () => Effect.succeed({ questions: "many" }) }))).toEqual({ ...world.root, questions: 0 })
  expect(await holdsOf(OpenCodeHolds.layer({ ...asks(world), queue: () => Effect.die("broken") }))).toEqual({ ...world.root, waits: [] })
})
