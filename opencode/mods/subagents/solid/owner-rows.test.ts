// The owner reader's rows through a refetch, as the Prime strip and the dock
// draw them (`visible` over the family, and the count of who works): a long
// root with hundreds of children that finished weeks ago and four that work
// now. Its event stream reconnects after a service restart (`server.connected`)
// and host work keeps arriving (`shell.created`) while the owner's read is in
// flight. Every state the reader publishes is recorded, so a list painted for
// a single frame counts: the strip may never draw a child of an earlier run,
// nor drop a live one, and the count always equals the rows drawn. Bun's tests
// resolve solid-js to its server build, which never re-runs a computation, so
// this file takes the reactive build OpenCode loads.
import { expect, mock, test } from "bun:test"
import type { OwnerAnswer, RowsReply } from "../../kernel/opencode/child-row.ts"
import type { Reads } from "../opencode/view.ts"

const REACTIVE = { core: "solid-js/dist/solid.js", store: "solid-js/store/dist/store.js" }
mock.module("solid-js", () => import(REACTIVE.core))
mock.module("solid-js/store", () => import(REACTIVE.store))
const { createComputed, createRoot } = await import("solid-js")
const { ownerRows } = await import("./owner-rows.ts")
const { subagents, visible } = await import("../subagent-row.ts")
const { worksNow } = await import("../works.ts")

const DAY = 86_400_000
/** Three weeks after the old children ended. */
const NOW = 21 * DAY
const OLD = Array.from({ length: 300 }, (_, index) => `ses_old${String(index).padStart(3, "0")}`)
const LIVE = ["ses_live0", "ses_live1", "ses_live2", "ses_live3"]

/** The owner's answer for `child`: the old ones settled weeks ago, the live ones running. */
const answer = (child: string, revision: number): OwnerAnswer => ({
  child,
  mark: { _tag: "Unreadable" },
  observation: {
    version: 1,
    child,
    revision,
    basis: "current",
    phase: LIVE.includes(child) ? { _tag: "Running" } : { _tag: "Settled", outcome: "succeeded", cause: "Unknown" },
  },
  at: LIVE.includes(child) ? NOW - 60_000 : 1_000,
  fact: { _tag: "NoFact" },
})

/** The root's family in the host's store, an event stream, and the owner RPC whose reads the test answers one at a time. */
function world() {
  const handlers = new Set<(event: { readonly details: object }) => void>()
  const flights: Array<{ readonly children: ReadonlyArray<string>; readonly answer: (reply: RowsReply) => void }> = []
  const children = [...OLD, ...LIVE]
  const reads: Reads = {
    listen: (handler) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    session: {
      get: (id) => ({ id, parentID: id === "root" ? null : "root", time: { created: id === "root" ? 0 : children.indexOf(id) + 1 } }),
      root: () => "root",
      family: () => ["root", ...children],
      status: (id) => (LIVE.includes(id) ? "running" : "idle"),
      permission: { list: () => [] },
      form: { list: () => [] },
      message: { list: () => [] },
    },
    shell: { list: () => [] },
  }
  const client = {
    rpc: () => ({
      read: (input: { readonly children: ReadonlyArray<string> }) =>
        new Promise<RowsReply>((answer) => flights.push({ children: input.children, answer })),
    }),
  }
  const reader = ownerRows({ data: reads, client, location: { directory: "/scratch/root" } })
  /** Each state the strip draws: its rows' ids and the dock's count. */
  const drawn: Array<{ readonly rows: ReadonlyArray<string>; readonly count: number }> = []
  const close = createRoot((dispose) => {
    createComputed(() => {
      const family = reader(reads, "root")
      const works = worksNow(family)
      drawn.push({
        rows: visible(subagents(family, "root"), NOW).map((row) => row.id),
        count: family.sessions.filter((session) => session.id !== "root" && works(session.id) !== undefined).length,
      })
    })
    return dispose
  })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5))
  return {
    drawn,
    close,
    emit: (type: string) => handlers.forEach((handler) => handler({ details: { type, data: {} } })),
    /** Answers the oldest read in flight with revision `revision`, and lets its publish land. */
    answer: async (revision: number) => {
      await settle()
      const flight = flights.shift()
      if (!flight) throw new Error("no read in flight")
      flight.answer({ rows: flight.children.map((child) => answer(child, revision)) })
      await settle()
    },
    inFlight: () => flights.length,
  }
}

test("a reconnect and host work during a refetch never draw an old child, never drop a live one, and the count equals the rows", async () => {
  const host = world()
  await host.answer(1)
  // The service restarted: the event stream reconnects, and host work arrives while the read it starts is in flight.
  host.emit("server.connected")
  host.emit("shell.created")
  await host.answer(2)
  // The coalesced read, and one more event's.
  host.emit("experimental.job.updated")
  await host.answer(3)
  await host.answer(4)
  host.close()
  const states = host.drawn.slice(1)
  expect(states.length).toBeGreaterThan(0)
  for (const state of states) {
    expect(state.rows).toEqual(LIVE)
    expect(state.count).toBe(state.rows.length)
  }
})
