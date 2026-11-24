// The owner's answers through a refetch, as the Prime strip and the dock draw
// them (`visible` over the family, and the count of who works): a long root
// with hundreds of children that finished weeks ago and four that work now.
// Its event stream reconnects after a service restart (`server.connected`) and
// host work keeps arriving (`shell.created`, a job's update) while the owner's
// read is in flight. Every list the reader publishes is checked, so a list
// painted for a single frame counts: the strip may never draw a child of an
// earlier run, nor drop a live one, and the count always equals the rows drawn.
import { expect } from "bun:test"
import { Effect, Option, Queue } from "effect"
import { it } from "effect-bun-test"
import type { RowsReply } from "../../kernel/opencode/child-row.ts"
import { Phase } from "../../kernel/child-lifecycle.ts"
import { RowFact } from "../../kernel/child-row.ts"
import { MarkRead } from "../../wake/latch.ts"
import type { OwnedRow } from "../family.ts"
import { message, read, type Reads, type SessionInfo } from "../opencode/view.ts"
import { subagents, visible } from "../subagent-row.ts"
import { worksNow } from "../works.ts"
import { followOwner, type RowsClient } from "./owner-rows.ts"

const DAY = 86_400_000
/** Three weeks after the old children ended. */
const NOW = 21 * DAY
const OLD = Array.from({ length: 300 }, (_, index) => `ses_old${String(index).padStart(3, "0")}`)
const LIVE = ["ses_live0", "ses_live1", "ses_live2", "ses_live3"]
const CHILDREN = [...OLD, ...LIVE]
const LOCATION = { directory: "/scratch/root" }
const isLive = (child: string) => LIVE.includes(child)

/** The owner's answer for `child` at `revision`: the old ones settled weeks ago, the live ones running. */
const answer = (child: string, revision: number) => {
  const live = Option.liftPredicate(child, isLive)
  return {
    child,
    mark: MarkRead.cases.Unreadable.make({}),
    observation: {
      version: 1 as const,
      child,
      revision,
      basis: "current" as const,
      phase: Option.match(live, {
        onSome: () => Phase.cases.Running.make({}),
        onNone: () => Phase.cases.Settled.make({ outcome: "succeeded", cause: "Unknown" }),
      }),
    },
    at: Option.match(live, { onSome: () => NOW - 60_000, onNone: () => 1_000 }),
    fact: RowFact.cases.NoFact.make({}),
  }
}

const infos = new Map<string, SessionInfo>([
  ["root", { id: "root", time: { created: 0 } }],
  ...CHILDREN.map((id, index) => [id, { id, parentID: "root", time: { created: index + 1 } }] as const),
])

type Flight = { readonly children: ReadonlyArray<string>; readonly reply: (reply: RowsReply) => void }

/** What the strip draws from one published answer: its rows' ids, and the dock's count of who works. */
const drawn = (reads: Reads<typeof LOCATION>, rows: ReadonlyArray<OwnedRow>) => {
  const family = read(reads, "root", LOCATION, message, new Map(rows.map((row) => [row.child, row])))
  const works = worksNow(family)
  return {
    rows: visible(subagents(family, "root"), NOW).map((row) => row.id),
    count: family.sessions.filter((session) => session.id !== "root" && Option.isSome(Option.fromUndefinedOr(works(session.id)))).length,
  }
}

it.effect("a reconnect and host work during a refetch never draw an old child, never drop a live one, and the count equals the rows", () =>
    Effect.gen(function* () {
      const flights = yield* Queue.unbounded<Flight>()
      const published = yield* Queue.unbounded<ReadonlyArray<OwnedRow>>()
      const handlers = new Set<(event: { readonly details: object }) => void>()
      const reads: Reads<typeof LOCATION> = {
        listen: (handler) => {
          handlers.add(handler)
          return () => handlers.delete(handler)
        },
        session: {
          get: (id) => infos.get(id),
          root: () => "root",
          family: () => ["root", ...CHILDREN],
          status: (id) => Option.match(Option.liftPredicate(id, isLive), { onSome: () => "running" as const, onNone: () => "idle" as const }),
          permission: { list: () => [] },
          form: { list: () => [] },
          message: { list: () => [] },
        },
        shell: { list: () => [] },
      }
      const client: RowsClient = {
        rpc: () => ({
          // The test answers each read in flight, in the order they were made.
          read: (input) => {
            const { promise, resolve } = Promise.withResolvers<RowsReply>()
            Queue.offerUnsafe(flights, { children: input.children, reply: resolve })
            return promise
          },
        }),
      }
      const emit = (type: string) => Effect.sync(() => handlers.forEach((handler) => handler({ details: { type, data: {} } })))
      /** Answers the oldest read in flight at `revision`, and checks the list the strip draws next. */
      const answerAndCheck = (revision: number) =>
        Effect.gen(function* () {
          const flight = yield* Queue.take(flights)
          yield* Effect.sync(() => flight.reply({ rows: flight.children.map((child) => answer(child, revision)) }))
          const shown = drawn(reads, yield* Queue.take(published))
          expect(shown.rows).toEqual(LIVE)
          expect(shown.count).toBe(shown.rows.length)
        })
      const stop = followOwner({ client, location: LOCATION })(reads, CHILDREN, (rows) => {
        Queue.offerUnsafe(published, rows)
      })
      yield* answerAndCheck(1)
      // The service restarted: the event stream reconnects, and host work arrives while the read it starts is in flight.
      yield* emit("server.connected")
      yield* emit("shell.created")
      yield* answerAndCheck(2)
      // The coalesced read, with one more event's.
      yield* emit("experimental.job.updated")
      yield* answerAndCheck(3)
      yield* answerAndCheck(4)
      // Nothing else was painted.
      expect(yield* Queue.clear(published)).toEqual([])
      yield* Effect.sync(stop)
    }),
)
