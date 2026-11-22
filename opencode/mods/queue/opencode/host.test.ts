// The host adapter over a stand-in for the plugin context's views: what the
// sweep reads of each session, of the wakes' and questions' RPCs, and how a
// note goes.
import { describe, expect } from "bun:test"
import { DateTime, Effect, Option, Schema } from "effect"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { QueueHost } from "../service.ts"
import { type Host, layer, type SessionRecord } from "./host.ts"

const TIMEOUT_MS = 5_000

const at = (ms: number) => DateTime.makeUnsafe(ms)

/** The host's failure for a session it does not have. */
class NotFound extends Schema.TaggedError<NotFound>()("Session.NotFoundError", {}) {}
/** Any other failure of the host. */
class Down extends Schema.TaggedError<Down>()("Down", { message: Schema.String }) {}

const sessions: ReadonlyArray<SessionRecord> = [
  { id: "ses_busy", time: { updated: at(50), busy: at(40), idle: at(30) } },
  { id: "ses_child", parentID: "ses_busy", time: { updated: at(55) } },
  { id: "ses_idle", outcome: "failed", time: { updated: at(60), busy: at(20), idle: at(45) } },
  { id: "ses_new", time: { updated: at(10) } },
]

const host = (overrides: Partial<Host> = {}): Host =>
  Object.assign(
    {
      sessions: Effect.succeed(sessions),
      get: (sessionID: string) =>
        Option.match(Option.fromNullishOr(sessions.find((session) => session.id === sessionID)), {
          onNone: () => Effect.fail(new NotFound()),
          onSome: (found) => Effect.succeed(found),
        }),
      pending: () =>
        Effect.succeed({
          now: 0,
          entries: [
            { id: "w000001", kind: "alarm", sessionID: "ses_busy" },
            { id: "w000002", kind: "latch", sessionID: "ses_busy" },
            { id: "w000003", kind: "monitor", sessionID: "ses_other" },
          ],
        }),
      open: () => Effect.succeed({ questions: [{ sessionID: "ses_busy" }, { sessionID: "ses_busy" }, { sessionID: "ses_other" }] }),
      lost: () => Effect.fail(new Down({ message: "no such rpc" })),
      synthetic: () => Effect.void,
    },
    overrides,
  )

const use = <A, E>(target: Host, body: (service: QueueHost["Service"]) => Effect.Effect<A, E>) => QueueHost.use(body).pipe(Effect.provide(layer(target)))

describe("the host as the sweep reads it", () => {
  effectTest(
    "a root runs while its latest start is after its latest end; a subagent that runs is busy, one that ended is idle since its end, one the host lacks is gone",
    Effect.gen(function* () {
      expect(yield* use(host(), (service) => service.roots)).toEqual([
        { id: "ses_busy", busy: true, updated: 50 },
        { id: "ses_idle", busy: false, updated: 60 },
        { id: "ses_new", busy: false, updated: 10 },
      ])
      expect(yield* use(host(), (service) => service.linked("ses_busy"))).toEqual(Option.some({ state: "busy" }))
      expect(yield* use(host(), (service) => service.linked("ses_idle"))).toEqual(Option.some({ state: "idle", since: 45, outcome: Option.some("failed") }))
      expect(yield* use(host(), (service) => service.linked("ses_new"))).toEqual(Option.some({ state: "idle", since: 10, outcome: Option.none() }))
      expect(yield* use(host(), (service) => service.linked("ses_none"))).toEqual(Option.some({ state: "gone" }))
      expect(yield* use(host({ get: () => Effect.fail(new Down({ message: "down" })) }), (service) => service.linked("ses_busy"))).toEqual(Option.none())
      expect(yield* use(host({ sessions: Effect.fail(new Down({ message: "down" })) }), (service) => service.roots)).toEqual([])
    }),
    TIMEOUT_MS,
  )

  effectTest(
    "the wakes' alarms and monitors and the open questions are read per session; a plugin that does not answer is none",
    Effect.gen(function* () {
      expect(yield* use(host(), (service) => service.wakes(["ses_busy", "ses_idle"]))).toEqual(
        Option.some(
          new Map([
            ["ses_busy", ["w000001"]],
            ["ses_idle", []],
          ]),
        ),
      )
      expect(yield* use(host(), (service) => service.questions(["ses_busy", "ses_idle"]))).toEqual(
        Option.some(
          new Map([
            ["ses_busy", 2],
            ["ses_idle", 0],
          ]),
        ),
      )
      const silent = host({ pending: () => Effect.succeed({ nonsense: true }), open: () => Effect.fail(new Down({ message: "no such rpc" })) })
      expect(yield* use(silent, (service) => service.wakes(["ses_busy"]))).toEqual(Option.none())
      expect(yield* use(silent, (service) => service.questions(["ses_busy"]))).toEqual(Option.none())
    }),
    TIMEOUT_MS,
  )

  effectTest(
    "orchestrate's lost work is read for the session and the commits asked; an answer that does not read, or no orchestrate, is none",
    Effect.gen(function* () {
      const asked: Array<unknown> = []
      const answering = host({
        lost: (input) =>
          Effect.sync(() => {
            asked.push(input)
            return { lines: ["orchestrate: …"], keys: ["/code/.work/app/orphan"], hashes: [{ hash: "c0ffee1", why: "not on main" }] }
          }),
      })
      expect(yield* use(answering, (service) => service.lost("ses_busy", ["c0ffee1"]))).toEqual(
        Option.some({ lines: ["orchestrate: …"], keys: ["/code/.work/app/orphan"], hashes: new Map([["c0ffee1", "not on main"]]) }),
      )
      expect(asked).toEqual([{ sessionID: "ses_busy", hashes: ["c0ffee1"] }])
      expect(yield* use(host({ lost: () => Effect.succeed({ nonsense: true }) }), (service) => service.lost("ses_busy", []))).toEqual(Option.none())
      expect(yield* use(host(), (service) => service.lost("ses_busy", []))).toEqual(Option.none())
    }),
    TIMEOUT_MS,
  )

  effectTest(
    "the note goes as the host's synthetic message, waking or not; a refusal says why",
    Effect.gen(function* () {
      const sent: Array<unknown> = []
      const target = host({ synthetic: (input) => Effect.sync(() => sent.push(input)) })
      yield* use(target, (service) => service.note("ses_idle", "check", "Queue check", true, "staleness"))
      expect(sent).toEqual([{ sessionID: "ses_idle", text: "check", description: "Queue check", resume: true, kind: "staleness" }])
      const gone = yield* use(host({ synthetic: () => Effect.fail(new NotFound()) }), (service) => Effect.flip(service.note("ses_gone", "check", "Queue check", false, "answer")))
      expect([gone._tag, gone.message]).toEqual(["NoteRefused", "no such session"])
      const down = yield* use(host({ synthetic: () => Effect.fail(new Down({ message: "busy elsewhere" })) }), (service) =>
        Effect.flip(service.note("ses_idle", "check", "Queue check", true, "staleness")),
      )
      expect(down.message).toBe("busy elsewhere")
    }),
    TIMEOUT_MS,
  )

  effectTest(
    "a call the host never answers is cut off and counts as failed, so it holds up no pass",
    Effect.gen(function* () {
      const hung = host({ sessions: Effect.never, get: () => Effect.never, pending: () => Effect.never, open: () => Effect.never, lost: () => Effect.never, synthetic: () => Effect.never })
      const cut = <A, E>(body: (service: QueueHost["Service"]) => Effect.Effect<A, E>) => QueueHost.use(body).pipe(Effect.provide(layer(hung, "20 millis")))
      expect(yield* cut((service) => service.roots)).toEqual([])
      expect(yield* cut((service) => service.linked("ses_busy"))).toEqual(Option.none())
      expect(yield* cut((service) => service.wakes(["ses_busy"]))).toEqual(Option.none())
      expect(yield* cut((service) => service.questions(["ses_busy"]))).toEqual(Option.none())
      expect(yield* cut((service) => service.lost("ses_busy", []))).toEqual(Option.none())
      const late = yield* cut((service) => Effect.flip(service.note("ses_idle", "check", "Queue check", true, "staleness")))
      expect([late._tag, late.message]).toEqual(["NoteRefused", "the host did not answer in time"])
    }),
    TIMEOUT_MS,
  )
})
