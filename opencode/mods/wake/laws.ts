// What every implementation of WakeStore, Courier, Backstop and Opener owes, as shared
// test suites. Each implementation's test beside it runs the suite over its
// Layer.
import { describe, expect, test } from "bun:test"
import { Effect, type Layer, type Scope } from "effect"
import type { Latch, Mark, Opened } from "./latch.ts"
import type { Letter } from "./message.ts"
import { Backstop, Courier, Opener, WakeStore } from "./service.ts"
import type { Alarm, Monitor, Notice } from "./wake.ts"

const scenario = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body))

const SET = 1_700_000_000_000

export const alarm: Alarm = {
  kind: "alarm",
  id: "w000001",
  sessionID: "ses_a",
  directory: "/work/app",
  mode: "wake",
  note: "Check CI run 42: green means merge.",
  setAt: SET,
  dueAt: SET + 60_000,
}

export const repeating: Alarm = {
  ...alarm,
  id: "w000002",
  mode: "wake",
  everySeconds: 300,
  newSession: { directory: "/work/other", prompt: "Summarise the night's builds." },
  firing: { delivery: "msg_a", session: "ses_new", text: "Wake", description: "wake w000002", metadata: { source: "wake", lateMs: 0 }, firedAt: SET + 60_000, tick: SET + 60_000 },
}

export const monitor: Monitor = {
  kind: "monitor",
  id: "w000003",
  sessionID: "ses_b",
  directory: "/work/app",
  mode: "notify",
  note: "The deploy is live: tell the user.",
  setAt: SET,
  command: "curl -fsS localhost:3000/health",
  cwd: "/work/app",
  intervalSeconds: 30,
  until: "ok",
  deadline: SET + 1_800_000,
}

export const watching: Monitor = {
  ...monitor,
  id: "w000005",
  mode: "wake",
  repeat: "change",
  matching: true,
  seen: "811c9dc5",
  fired: 2,
  firing: { delivery: "msg_w", text: "Monitor", description: "monitor w000005 changed", metadata: { source: "wake" }, firedAt: SET + 60_000, tick: SET + 60_000, again: true },
}

export const latch: Latch = {
  kind: "latch",
  id: "w000004",
  sessionID: "ses_a",
  directory: "/work/app",
  setAt: SET,
  child: "ses_child",
  subagent: {
    agent: "implementor",
    description: "Add the export",
    prompt: "Add the CSV export to the report page.",
    model: "anthropic/claude-opus#high",
    from: "build",
    messageID: "msg_parent",
    callID: "call_1",
  },
  hold: "pace",
  reason: "anthropic is at 92% of its 5h window",
  opensAt: SET + 600_000,
  recheckAt: SET + 120_000,
  context: { whose: "pool", background: false },
}

export const notice: Notice = { delivery: "msg_n", wakeID: "w000003", sessionID: "ses_b", directory: "/work/app", description: "monitor w000003 matched · The deploy", firedAt: SET }

/** A store under test: its Layer, and a way to make one stored entry unreadable. */
export interface StoreProbe {
  readonly layer: Layer.Layer<WakeStore>
  readonly spoil: (id: string) => Effect.Effect<void>
}

/** `make` gives an empty store within the test's scope. */
export const storeLaws = (name: string, make: Effect.Effect<StoreProbe, never, Scope.Scope>) =>
  describe(`${name} keeps the WakeStore laws`, () => {
    const using = (probe: StoreProbe) => <A, E>(body: (store: WakeStore["Service"]) => Effect.Effect<A, E>) => WakeStore.use(body).pipe(Effect.provide(probe.layer))

    test("an empty store has no entries, ids or notices", () =>
      scenario(
        Effect.gen(function* () {
          const run = using(yield* make)
          expect(yield* run((store) => store.entries)).toEqual([])
          expect(yield* run((store) => store.ids)).toEqual([])
          expect(yield* run((store) => store.notices)).toEqual([])
          expect(yield* run((store) => store.read("w000001"))).toBeUndefined()
        }),
      ))

    test("reads what was last written, every field kept, for alarms and monitors", () =>
      scenario(
        Effect.gen(function* () {
          const run = using(yield* make)
          for (const entry of [alarm, repeating, monitor, watching, latch]) yield* run((store) => store.write(entry))
          expect(yield* run((store) => store.read(alarm.id))).toEqual(alarm)
          expect(yield* run((store) => store.read(repeating.id))).toEqual(repeating)
          expect(yield* run((store) => store.read(monitor.id))).toEqual(monitor)
          expect(yield* run((store) => store.read(watching.id))).toEqual(watching)
          expect(yield* run((store) => store.read(latch.id))).toEqual(latch)
          const moved = { ...alarm, dueAt: alarm.dueAt + 1 }
          yield* run((store) => store.write(moved))
          expect(yield* run((store) => store.read(alarm.id))).toEqual(moved)
          expect((yield* run((store) => store.entries)).map((entry) => entry.id).toSorted()).toEqual([alarm.id, repeating.id, monitor.id, latch.id, watching.id])
          expect((yield* run((store) => store.ids)).toSorted()).toEqual([alarm.id, repeating.id, monitor.id, latch.id, watching.id])
        }),
      ))

    test("remove forgets an entry, and removing none succeeds", () =>
      scenario(
        Effect.gen(function* () {
          const run = using(yield* make)
          yield* run((store) => store.write(alarm))
          yield* run((store) => store.remove(alarm.id))
          yield* run((store) => store.remove(alarm.id))
          expect(yield* run((store) => store.read(alarm.id))).toBeUndefined()
          expect(yield* run((store) => store.ids)).toEqual([])
        }),
      ))

    test("an entry that no longer reads is left out of entries but kept in ids; a write replaces it", () =>
      scenario(
        Effect.gen(function* () {
          const probe = yield* make
          const run = using(probe)
          yield* run((store) => store.write(alarm))
          yield* probe.spoil(alarm.id)
          expect(yield* run((store) => store.read(alarm.id))).toBeUndefined()
          expect(yield* run((store) => store.entries)).toEqual([])
          expect(yield* run((store) => store.ids)).toEqual([alarm.id])
          yield* run((store) => store.write(alarm))
          expect(yield* run((store) => store.read(alarm.id))).toEqual(alarm)
        }),
      ))

    test("keeps notices by their delivery id apart from the entries", () =>
      scenario(
        Effect.gen(function* () {
          const run = using(yield* make)
          yield* run((store) => store.writeNotice(notice))
          expect(yield* run((store) => store.notices)).toEqual([notice])
          expect(yield* run((store) => store.entries)).toEqual([])
          yield* run((store) => store.removeNotice(notice.delivery))
          yield* run((store) => store.removeNotice(notice.delivery))
          expect(yield* run((store) => store.notices)).toEqual([])
        }),
      ))
  })

/** A message a session received: its id, what it carried, and whether it woke the session. */
export interface Received {
  readonly id: string
  readonly letter: Letter
  readonly resume: boolean
}

/** A latch's child as the host holds it: its parent, title, agent, model, mark, and how many prompts it took. */
export interface Inspected {
  readonly parentID: string | undefined
  readonly title: string | undefined
  readonly agent: string | undefined
  readonly model: string | undefined
  readonly mark: Mark | undefined
  readonly prompts: number
}

/** A courier under test: its Layer, a way to open a session (under a parent), what a session received, the prompts a started one has, and what a child is. */
export interface CourierProbe {
  readonly layer: Layer.Layer<Courier>
  readonly open: (sessionID: string, parentID?: string) => Effect.Effect<void>
  readonly received: (sessionID: string) => Effect.Effect<ReadonlyArray<Received>>
  readonly started: (sessionID: string) => Effect.Effect<{ readonly directory: string; readonly prompts: ReadonlyArray<{ readonly id: string; readonly text: string }> } | undefined>
  readonly inspect: (sessionID: string) => Effect.Effect<Inspected | undefined>
}

const mark: Mark = { hold: "pace", reason: "anthropic is at 92% of its 5h window", opensAt: SET + 600_000, at: SET }

const letter: Letter = { text: "⏰ Wake w000001 fired.\nNote: Check CI.", description: "wake w000001 · Check CI.", metadata: { source: "wake", id: "w000001", lateMs: 0 } }

/** `make` gives a courier with no sessions within the test's scope. */
export const courierLaws = (name: string, make: Effect.Effect<CourierProbe, never, Scope.Scope>) =>
  describe(`${name} keeps the Courier laws`, () => {
    const using = (probe: CourierProbe) => <A, E>(body: (courier: Courier["Service"]) => Effect.Effect<A, E>) => Courier.use(body).pipe(Effect.provide(probe.layer))

    test("delivery ids are distinct message ids, each sorting after the one before; session ids are distinct session ids", () =>
      scenario(
        Effect.gen(function* () {
          const run = using(yield* make)
          const ids = yield* Effect.forEach(Array.from({ length: 20 }), () => run((courier) => courier.newDelivery))
          expect(new Set(ids).size).toBe(ids.length)
          expect(ids.toSorted()).toEqual(ids)
          for (const id of ids) expect(id).toMatch(/^msg_/)
          const sessions = yield* Effect.forEach(Array.from({ length: 20 }), () => run((courier) => courier.newSession))
          expect(new Set(sessions).size).toBe(sessions.length)
          for (const id of sessions) expect(id).toMatch(/^ses_/)
        }),
      ))

    test("delivers the letter under its id, waking the session or not as asked, and once per id", () =>
      scenario(
        Effect.gen(function* () {
          const probe = yield* make
          const run = using(probe)
          yield* probe.open("ses_a")
          const woke = yield* run((courier) => courier.newDelivery)
          const quiet = yield* run((courier) => courier.newDelivery)
          yield* run((courier) => courier.deliver("ses_a", woke, letter, true))
          yield* run((courier) => courier.deliver("ses_a", woke, letter, true))
          yield* run((courier) => courier.deliver("ses_a", quiet, letter, false))
          expect(yield* probe.received("ses_a")).toEqual([
            { id: woke, letter, resume: true },
            { id: quiet, letter, resume: false },
          ])
        }),
      ))

    test("a session that does not exist refuses with DeliveryRefused naming it, as gone", () =>
      scenario(
        Effect.gen(function* () {
          const run = using(yield* make)
          const id = yield* run((courier) => courier.newDelivery)
          const failure = yield* run((courier) => courier.deliver("ses_gone", id, letter, true)).pipe(Effect.flip)
          expect(failure._tag).toBe("DeliveryRefused")
          expect(failure.sessionID).toBe("ses_gone")
          expect(failure.gone).toBe(true)
          expect(failure.message).not.toBe("")
        }),
      ))

    test("start makes the session under its minted id in its directory with one prompt, however often it is sent", () =>
      scenario(
        Effect.gen(function* () {
          const probe = yield* make
          const run = using(probe)
          const sessionID = yield* run((courier) => courier.newSession)
          const delivery = yield* run((courier) => courier.newDelivery)
          const start = { sessionID, directory: "/work/other", delivery, text: "Summarise the night's builds." }
          yield* run((courier) => courier.start(start))
          yield* run((courier) => courier.start(start))
          expect(yield* probe.started(sessionID)).toEqual({ directory: "/work/other", prompts: [{ id: delivery, text: start.text }] })
        }),
      ))

    test("parentOf names a subagent's parent, and none for a root session or one that does not exist", () =>
      scenario(
        Effect.gen(function* () {
          const probe = yield* make
          const run = using(probe)
          yield* probe.open("ses_root")
          yield* probe.open("ses_child", "ses_root")
          expect(yield* run((courier) => courier.parentOf("ses_child"))).toBe("ses_root")
          expect(yield* run((courier) => courier.parentOf("ses_root"))).toBeUndefined()
          expect(yield* run((courier) => courier.parentOf("ses_none"))).toBeUndefined()
        }),
      ))

    test("child makes a latch's child under its id, under its parent, carrying its mark, unprompted, once however often", () =>
      scenario(
        Effect.gen(function* () {
          const probe = yield* make
          const run = using(probe)
          yield* probe.open("ses_root")
          const sessionID = yield* run((courier) => courier.newSession)
          const child = { sessionID, parentID: "ses_root", directory: "/work/app", title: "Add the export", agent: "implementor", model: "anthropic/claude-opus#high", mark }
          yield* run((courier) => courier.child(child))
          yield* run((courier) => courier.child(child))
          expect(yield* probe.inspect(sessionID)).toEqual({
            parentID: "ses_root",
            title: "Add the export",
            agent: "implementor",
            model: "anthropic/claude-opus#high",
            mark,
            prompts: 0,
          })
          expect(yield* run((courier) => courier.parentOf(sessionID))).toBe("ses_root")
        }),
      ))

    test("a child of a parent that does not exist refuses as gone", () =>
      scenario(
        Effect.gen(function* () {
          const run = using(yield* make)
          const sessionID = yield* run((courier) => courier.newSession)
          const failure = yield* run((courier) =>
            courier.child({ sessionID, parentID: "ses_gone", directory: "/work/app", title: "Add the export", agent: "implementor", mark }),
          ).pipe(Effect.flip)
          expect(failure.gone).toBe(true)
        }),
      ))

    test("mark replaces a child's mark and clears it with none; a session that does not exist is no failure", () =>
      scenario(
        Effect.gen(function* () {
          const probe = yield* make
          const run = using(probe)
          yield* probe.open("ses_root")
          const sessionID = yield* run((courier) => courier.newSession)
          yield* run((courier) => courier.child({ sessionID, parentID: "ses_root", directory: "/work/app", title: "Add the export", agent: "implementor", mark }))
          const cancelled = { ...mark, cancelledAt: SET + 5000 }
          yield* run((courier) => courier.mark(sessionID, cancelled))
          expect((yield* probe.inspect(sessionID))?.mark).toEqual(cancelled)
          yield* run((courier) => courier.mark(sessionID, undefined))
          expect((yield* probe.inspect(sessionID))?.mark).toBeUndefined()
          yield* run((courier) => courier.mark("ses_none", mark))
        }),
      ))
  })

/** A backstop under test: its Layer, and a way to plant a job that is not a wake's. */
export interface BackstopProbe {
  readonly layer: Layer.Layer<Backstop>
  readonly plant: (title: string) => Effect.Effect<void>
}

const job = { id: "w000001", title: "opencode-wake-w000001", directory: "/work/app" }

/** `make` gives a backstop with no wake jobs within the test's scope. */
export const backstopLaws = (name: string, make: Effect.Effect<BackstopProbe, never, Scope.Scope>) =>
  describe(`${name} keeps the Backstop laws`, () => {
    const using = (probe: BackstopProbe) => <A, E>(body: (backstop: Backstop["Service"]) => Effect.Effect<A, E>) => Backstop.use(body).pipe(Effect.provide(probe.layer))

    test("lists what was registered, once however often, and forgets what was removed", () =>
      scenario(
        Effect.gen(function* () {
          const run = using(yield* make)
          expect(yield* run((backstop) => backstop.titles)).toEqual([])
          yield* run((backstop) => backstop.register(job, { cron: "30 14 5 11 *", recurring: false }))
          yield* run((backstop) => backstop.register(job, { cron: "31 14 5 11 *", recurring: false }))
          yield* run((backstop) => backstop.register({ ...job, id: "w000002", title: "opencode-wake-w000002" }, { cron: "*/5 * * * *", recurring: true }))
          expect((yield* run((backstop) => backstop.titles)).toSorted()).toEqual(["opencode-wake-w000001", "opencode-wake-w000002"])
          yield* run((backstop) => backstop.remove("opencode-wake-w000001"))
          yield* run((backstop) => backstop.remove("opencode-wake-w000001"))
          expect(yield* run((backstop) => backstop.titles)).toEqual(["opencode-wake-w000002"])
        }),
      ))

    test("lists no job that is not a wake's", () =>
      scenario(
        Effect.gen(function* () {
          const probe = yield* make
          yield* probe.plant("nightly-report")
          expect(yield* using(probe)((backstop) => backstop.titles)).toEqual([])
        }),
      ))
  })

/** An opener under test: its Layer over an opener that answers `answer`, or none at all. */
export type OpenerOf = (answer: ((latch: Latch) => Opened) | undefined) => Layer.Layer<Opener>

export const openerLaws = (name: string, make: OpenerOf) =>
  describe(`${name} keeps the Opener laws`, () => {
    const open = (layer: Layer.Layer<Opener>) => Opener.use((opener) => opener.open(latch)).pipe(Effect.provide(layer))

    test("answers what the opener decided for the latch", async () => {
      const held: Opened = { outcome: "held", hold: "sabbath", reason: "It is the Sabbath", opensAt: SET + 1, recheckAt: SET + 1 }
      expect(await Effect.runPromise(open(make(() => ({ outcome: "opened" }))))).toEqual({ outcome: "opened" })
      expect(await Effect.runPromise(open(make(() => held)))).toEqual(held)
      expect(await Effect.runPromise(open(make((asked) => ({ outcome: "failed", message: asked.child }))))).toEqual({ outcome: "failed", message: latch.child })
    })

    test("no opener is OpenerUnavailable", async () => {
      const failure = await Effect.runPromise(open(make(undefined)).pipe(Effect.flip))
      expect(failure._tag).toBe("OpenerUnavailable")
    })
  })
