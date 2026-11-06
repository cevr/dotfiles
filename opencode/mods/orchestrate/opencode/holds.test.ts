// What the other plugins hold, over stand-ins for their RPCs: the laws, with
// each world answered as the wakes, the questions and the queue answer, and
// one plugin missing while the others answer.
import { expect, test } from "bun:test"
import { Effect } from "effect"
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
})

const failing = () => Effect.fail(new Error("no server"))

rootHoldsLaws("OpenCode's RootHolds", (world) =>
  OpenCodeHolds.layer(world === "unreadable" ? { pending: failing, open: failing, queue: failing } : asks(world)),
)

test("a plugin that is missing holds nothing, and the others still answer", async () => {
  const world = { root: { wakes: 1, questions: 2, needsYou: [], waits: ["owner review"] } }
  const holdsOf = (layer: ReturnType<typeof OpenCodeHolds.layer>) => Effect.runPromise(RootHolds.use((holds) => holds.of("root")).pipe(Effect.provide(layer)))
  expect(await holdsOf(OpenCodeHolds.layer({ ...asks(world), pending: failing }))).toEqual({ ...world.root, wakes: 0 })
  expect(await holdsOf(OpenCodeHolds.layer({ ...asks(world), open: () => Effect.succeed({ questions: "many" }) }))).toEqual({ ...world.root, questions: 0 })
  expect(await holdsOf(OpenCodeHolds.layer({ ...asks(world), queue: () => Effect.die("broken") }))).toEqual({ ...world.root, waits: [] })
})
