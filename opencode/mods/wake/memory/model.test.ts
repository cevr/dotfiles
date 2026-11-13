// The wakes model over the memory doubles, on the test clock: what a server
// does with an alarm or a monitor from the tool call to the fire, through a
// reload, a stop, and the OS backstop's call; and a latch from the moment it
// latches to its opening, a recheck still held, a cancel, and a restart.
import { describe, expect, test } from "bun:test"
import { Context, Effect, Exit, Layer, Logger, Scope } from "effect"
import { TestClock } from "effect/testing"
import { oneShot, titleOf } from "../backstop.ts"
import type { LatchAsk } from "../latch.ts"
import { alarm as alarmFixture, latch as latchFixture } from "../laws.ts"
import * as Model from "../model.ts"
import { OPEN_RETRY_MS, RETRY_MS, WakesModel } from "../model.ts"
import { Changes } from "../service.ts"
import type { Alarm, Entry } from "../wake.ts"
import * as MemoryBackstop from "./backstop.ts"
import * as MemoryChecks from "./checks.ts"
import * as MemoryCourier from "./courier.ts"
import * as MemoryOpener from "./opener.ts"
import * as MemoryRunner from "./runner.ts"
import * as MemoryStore from "./store.ts"

const DIR = "/work/app"
const SECOND = 1000
const MINUTE = 60 * SECOND

/** Lets the fibers a clock move woke run to their next wait. */
const settle = Effect.promise(() => new Promise<void>((done) => setTimeout(done, 2)))

const now = TestClock.testClockWith((clock) => Effect.sync(() => clock.currentTimeMillisUnsafe()))

/** Moves the test clock to `at`, letting each timer due on the way fire. */
const until = (at: number) =>
  Effect.gen(function* () {
    const current = yield* now
    if (at > current) yield* TestClock.adjust(at - current)
    yield* settle
  })

/** The externals one OpenCode keeps across its servers' lives: the storage, the sessions, the scheduler, the commands. */
const world = (...sessionIDs: ReadonlyArray<string>) => ({
  store: MemoryStore.empty(),
  sessions: MemoryCourier.empty(...sessionIDs),
  jobs: MemoryBackstop.empty(),
  checks: MemoryChecks.empty(),
  opener: MemoryOpener.empty(),
  runner: MemoryRunner.empty(),
  changed: [] as Array<string>,
})
type World = ReturnType<typeof world>

/** A server's wakes over `w`: built in its own scope, so closing it is a reload or a stop. */
const server = (w: World, directory = DIR) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const layer = Model.layer({ directory, settleMs: 5 * SECOND }).pipe(
      Layer.provide(MemoryStore.layer(w.store)),
      Layer.provide(MemoryCourier.layer(w.sessions)),
      Layer.provide(MemoryChecks.layer(w.checks)),
      Layer.provide(MemoryBackstop.layer(w.jobs)),
      Layer.provide(MemoryOpener.layer(w.opener)),
      Layer.provide(MemoryRunner.layer(w.runner)),
      Layer.provide(Layer.succeed(Changes, { changed: (sessionID) => Effect.sync(() => void w.changed.push(sessionID)) })),
    )
    const model = Context.get(yield* Layer.buildWithScope(layer, scope), WakesModel)
    return { model, stop: Scope.close(scope, Exit.void) }
  })

const run = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(body.pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([])))))

const inbox = (w: World, sessionID = "ses_a") => w.sessions.inboxes.get(sessionID) ?? []
const texts = (w: World, sessionID = "ses_a") => inbox(w, sessionID).map((message) => message.letter.text)
const firingOf = (entry: Entry | undefined) => (entry === undefined || entry.kind === "latch" ? undefined : entry.firing)

describe("an alarm", () => {
  test("wakes its session at its time with the note, then goes with its OS job", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        const { model } = yield* server(w)
        const placed = yield* model.wake("ses_a", { afterSeconds: 3, note: "Check CI run 42: green means merge." })
        expect(placed.warning).toBeUndefined()
        expect(w.jobs.jobs.get(titleOf(placed.entry.id))?.schedule).toEqual(oneShot(3 * SECOND))
        yield* until(2900)
        expect(inbox(w)).toEqual([])
        yield* until(3 * SECOND)
        expect(inbox(w)).toHaveLength(1)
        expect(inbox(w)[0]?.resume).toBe(true)
        expect(texts(w)[0]).toContain(`⏰ Wake ${placed.entry.id} fired`)
        expect(texts(w)[0]).toContain("Note: Check CI run 42: green means merge.")
        expect(texts(w)[0]).not.toContain("late")
        expect(w.store.entries.size).toBe(0)
        expect(w.jobs.jobs.size).toBe(0)
        expect(w.changed.filter((sessionID) => sessionID === "ses_a").length).toBeGreaterThanOrEqual(2)
      }),
    ))

  test("in notify mode starts no turn and leaves a notice until the session reads it", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        const { model } = yield* server(w)
        const placed = yield* model.wake("ses_a", { afterSeconds: 60, mode: "notify", note: "The build should be done." })
        yield* until(MINUTE)
        expect(inbox(w).map((message) => message.resume)).toEqual([false])
        const [notice] = [...w.store.notices.values()]
        expect(notice?.wakeID).toBe(placed.entry.id)
        expect(notice?.delivery).toBe(inbox(w)[0]?.id ?? "")
        expect((yield* model.pending(["ses_a"])).notices).toHaveLength(1)
        yield* model.read(notice?.delivery ?? "")
        expect((yield* model.pending(["ses_a"])).notices).toEqual([])
      }),
    ))

  test("a repeat fires every period, keeping its recurring job; one the cron fields cannot say gets a fresh one-shot each time", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        const { model } = yield* server(w)
        const minutely = yield* model.wake("ses_a", { afterSeconds: 60, everySeconds: 60, note: "poll" })
        const odd = yield* model.wake("ses_a", { afterSeconds: 90, everySeconds: 90, note: "odd" })
        expect(w.jobs.jobs.get(titleOf(minutely.entry.id))?.schedule.recurring).toBe(true)
        yield* until(3 * MINUTE)
        expect(texts(w).filter((text) => text.includes(minutely.entry.id))).toHaveLength(3)
        expect(texts(w).filter((text) => text.includes(odd.entry.id))).toHaveLength(2)
        expect(texts(w)[0]).toContain("It repeats every 1m; the next is due")
        const next = w.store.entries.get(odd.entry.id)
        expect(next?.kind === "alarm" ? next.dueAt : undefined).toBe(270 * SECOND)
        expect(firingOf(next)).toBeUndefined()
        expect(w.jobs.jobs.get(titleOf(odd.entry.id))?.schedule).toEqual(oneShot(270 * SECOND))
      }),
    ))

  test("a newSession alarm starts a session in its directory with the prompt", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        const { model } = yield* server(w)
        yield* model.wake("ses_a", { afterSeconds: 5, note: "nightly", newSession: { directory: "/work/other", prompt: "Summarise the builds." } })
        yield* until(5 * SECOND)
        const [[sessionID, started]] = [...w.sessions.started.entries()]
        expect(sessionID).toMatch(/^ses_/)
        expect(started?.directory).toBe("/work/other")
        expect(started?.prompts).toHaveLength(1)
        expect(started?.prompts[0]?.text.split("\n")[0]).toBe("Summarise the builds.")
        expect(inbox(w)).toEqual([])
        expect(w.store.entries.size).toBe(0)
      }),
    ))

  test("a refused fire goes again after a wait under the same id; a gone session drops the entry", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        const { model } = yield* server(w)
        w.sessions.refusing.set("ses_a", "busy")
        const placed = yield* model.wake("ses_a", { afterSeconds: 1, note: "n" })
        yield* until(SECOND)
        const recorded = firingOf(w.store.entries.get(placed.entry.id))
        expect(recorded).toBeDefined()
        w.sessions.refusing.delete("ses_a")
        yield* until(SECOND + RETRY_MS - 1)
        expect(inbox(w)).toEqual([])
        yield* until(SECOND + RETRY_MS)
        expect(inbox(w).map((message) => message.id)).toEqual([recorded?.delivery ?? ""])
        const lost = yield* model.wake("ses_a", { afterSeconds: 1, note: "n" })
        w.sessions.inboxes.delete("ses_a")
        yield* until((yield* now) + SECOND)
        expect(w.store.entries.has(lost.entry.id)).toBe(false)
        expect(w.jobs.jobs.has(titleOf(lost.entry.id))).toBe(false)
      }),
    ))

  test("with no OS scheduler it still fires while the server runs, and says it is unguarded", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        const { model } = yield* server(w)
        w.jobs.refusing = "no OS scheduler is supported on aix"
        const placed = yield* model.wake("ses_a", { afterSeconds: 1, note: "n" })
        expect(placed.warning).toContain("No OS backstop was set (no OS scheduler is supported on aix)")
        yield* until(SECOND)
        expect(inbox(w)).toHaveLength(1)
      }),
    ))
})

describe("a monitor", () => {
  test("checks on its interval and wakes on the first match, with the last output", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        w.checks.answers.set("gh pr checks 7", [MemoryChecks.check(1, "pending"), MemoryChecks.check(0, "booting\nall green")])
        const { model } = yield* server(w)
        const placed = yield* model.monitor("ses_a", { command: "gh pr checks 7", intervalSeconds: 5, until: "green", note: "merge it" })
        yield* settle
        expect(w.checks.runs).toEqual([{ command: "gh pr checks 7", cwd: DIR }])
        expect(inbox(w)).toEqual([])
        yield* until(5 * SECOND)
        expect(texts(w)).toHaveLength(1)
        expect(texts(w)[0]).toContain(`⏰ Monitor ${placed.entry.id} matched`)
        expect(texts(w)[0]).toContain("after 2 checks")
        expect(texts(w)[0]).toContain("booting\nall green")
        expect(w.store.entries.size).toBe(0)
        expect(w.jobs.jobs.size).toBe(0)
      }),
    ))

  test("the tray reads its interval, pattern and newest check's output, which goes with it", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        w.checks.answers.set("curl -s /health", [MemoryChecks.check(1, "", "refused"), MemoryChecks.check(0, "booting\nstill waiting"), MemoryChecks.check(0, "READY")])
        const { model } = yield* server(w)
        const placed = yield* model.monitor("ses_a", { command: "curl -s /health", intervalSeconds: 5, until: "^READY$", note: "deploy" })
        yield* settle
        const shown = (yield* model.pending(["ses_a"])).entries[0]
        expect(shown).toMatchObject({ id: placed.entry.id, kind: "monitor", command: "curl -s /health", intervalSeconds: 5, until: "^READY$" })
        expect(shown?.last).toEqual({ at: 0, exitCode: 1, output: "refused" })
        yield* until(5 * SECOND)
        expect((yield* model.pending(["ses_a"])).entries[0]?.last).toEqual({ at: 5 * SECOND, exitCode: 0, output: "booting\nstill waiting" })
        yield* until(10 * SECOND)
        expect((yield* model.pending(["ses_a"])).entries).toEqual([])
      }),
    ))

  test("wakes at its deadline when nothing matched", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        w.checks.answers.set("false", [MemoryChecks.check(1, "", "nope")])
        const { model } = yield* server(w)
        yield* model.monitor("ses_a", { command: "false", intervalSeconds: 3, timeoutSeconds: 10, note: "give up" })
        yield* until(9 * SECOND)
        expect(inbox(w)).toEqual([])
        yield* until(10 * SECOND)
        expect(texts(w)).toHaveLength(1)
        expect(texts(w)[0]).toContain("timed out")
        expect(texts(w)[0]).toContain("nope")
      }),
    ))
})

describe("a repeating monitor", () => {
  const monitorOf = (w: World, id: string) => {
    const entry = w.store.entries.get(id)
    return entry?.kind === "monitor" ? entry : undefined
  }

  test("match: wakes on each new match, not on a match after a match, and keeps checking with its OS job", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        const c = MemoryChecks.check
        w.checks.answers.set("ci", [c(1, "red"), c(0, "green 1"), c(0, "green 1"), c(1, "red"), c(0, "green 2"), c(0, "green 2")])
        const { model } = yield* server(w)
        const placed = yield* model.monitor("ses_a", { command: "ci", intervalSeconds: 5, repeat: "match", note: "main is green again" })
        yield* settle
        expect(inbox(w)).toEqual([])
        yield* until(5 * SECOND)
        expect(texts(w)).toHaveLength(1)
        expect(texts(w)[0]).toStartWith(`⏰ Monitor ${placed.entry.id} matched (fire 1): \`ci\`.`)
        expect(texts(w)[0]).toContain("Note: main is green again\nOutput (exit 0):\ngreen 1")
        yield* until(15 * SECOND)
        expect(texts(w)).toHaveLength(1)
        yield* until(20 * SECOND)
        expect(texts(w)).toHaveLength(2)
        expect(texts(w)[1]).toContain("(fire 2)")
        expect(texts(w)[1]).toContain("green 2")
        yield* until(30 * SECOND)
        expect(texts(w)).toHaveLength(2)
        expect(inbox(w).map((message) => message.resume)).toEqual([true, true])
        expect(monitorOf(w, placed.entry.id)).toMatchObject({ matching: true, fired: 2 })
        expect(firingOf(w.store.entries.get(placed.entry.id))).toBeUndefined()
        expect(w.jobs.jobs.has(titleOf(placed.entry.id))).toBe(true)
      }),
    ))

  test("change: the first match is the baseline; it wakes when the output changes, not when it stays, nor on a failed check, and the baseline outlives a reload", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        const c = MemoryChecks.check
        w.checks.answers.set("prs", [c(0, "7 PENDING"), c(0, "7 PENDING"), c(0, "7 APPROVED"), c(1, "", "rate limited"), c(0, "7 APPROVED")])
        const first = yield* server(w)
        const placed = yield* first.model.monitor("ses_a", { command: "prs", intervalSeconds: 5, repeat: "change", note: "a review changed" })
        yield* until(5 * SECOND)
        expect(inbox(w)).toEqual([])
        yield* until(10 * SECOND)
        expect(texts(w)).toHaveLength(1)
        expect(texts(w)[0]).toStartWith(`⏰ Monitor ${placed.entry.id} changed (fire 1)`)
        expect(texts(w)[0]).toContain("7 APPROVED")
        yield* until(15 * SECOND)
        yield* first.stop
        const second = yield* server(w)
        yield* second.model.start
        yield* until(MINUTE)
        expect(texts(w)).toHaveLength(1)
        expect(monitorOf(w, placed.entry.id)?.fired).toBe(1)
      }),
    ))

  test("a baseline given at set time is the first output it compares with", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        w.checks.answers.set("prs", [MemoryChecks.check(0, "7 APPROVED")])
        const { model } = yield* server(w)
        yield* model.monitor("ses_a", { command: "prs", intervalSeconds: 5, repeat: "change", baseline: "7 PENDING\n", note: "a review changed" })
        yield* settle
        expect(texts(w)).toHaveLength(1)
        expect(texts(w)[0]).toContain("changed (fire 1)")
      }),
    ))

  test("ends at its deadline with a last letter that counts its fires, then goes with its OS job", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        const c = MemoryChecks.check
        w.checks.answers.set("q", [c(0, "a"), c(0, "b"), c(0, "c")])
        const { model } = yield* server(w)
        const placed = yield* model.monitor("ses_a", { command: "q", intervalSeconds: 10, timeoutSeconds: 25, repeat: "change", note: "queue moved" })
        yield* until(25 * SECOND)
        expect(texts(w).map((text) => text.split("\n")[0])).toEqual([
          `⏰ Monitor ${placed.entry.id} changed (fire 1): \`q\`.`,
          `⏰ Monitor ${placed.entry.id} changed (fire 2): \`q\`.`,
          `⏰ Monitor ${placed.entry.id} ended: its deadline 1970-01-01T00:00:25.000Z passed after 2 fires; \`q\`.`,
        ])
        expect(w.store.entries.size).toBe(0)
        expect(w.jobs.jobs.size).toBe(0)
      }),
    ))

  test("a match fire cut short by a reload goes again under its id once, and the monitor goes on", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        const c = MemoryChecks.check
        w.checks.answers.set("ci", [c(0, "green"), c(1, "red"), c(0, "green again")])
        const first = yield* server(w)
        w.sessions.refusing.set("ses_a", "reloading")
        const placed = yield* first.model.monitor("ses_a", { command: "ci", intervalSeconds: 5, repeat: "match", note: "green" })
        yield* settle
        const firing = firingOf(w.store.entries.get(placed.entry.id))
        expect(firing?.again).toBe(true)
        yield* first.stop
        w.sessions.refusing.delete("ses_a")
        const second = yield* server(w)
        yield* second.model.start
        yield* settle
        expect(inbox(w).map((message) => message.id)).toEqual([firing?.delivery ?? ""])
        expect(monitorOf(w, placed.entry.id)).toMatchObject({ matching: true, fired: 1 })
        yield* until(10 * SECOND)
        expect(texts(w)).toHaveLength(2)
        expect(texts(w)[1]).toContain("(fire 2)")
      }),
    ))
})

describe("setting and cancelling", () => {
  test("cancel stops a wake and drops its job; an unknown id is refused, naming what is pending", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        const { model } = yield* server(w)
        const placed = yield* model.wake("ses_a", { afterSeconds: 3, note: "n" })
        const kept = yield* model.wake("ses_a", { afterSeconds: 3, note: "kept" })
        expect(yield* model.cancel("ses_a", placed.entry.id)).toEqual([placed.entry.id])
        expect(w.jobs.jobs.has(titleOf(placed.entry.id))).toBe(false)
        const refused = yield* Effect.flip(model.cancel("ses_a", "w999999"))
        expect(refused.reason).toBe(`No pending wake w999999 in this session. Pending: ${kept.entry.id}.`)
        expect(yield* model.cancel("ses_a")).toEqual([kept.entry.id])
        yield* until(10 * SECOND)
        expect(inbox(w)).toEqual([])
      }),
    ))

  test("a subagent is refused; a full session is refused", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a", "ses_child")
        w.sessions.parents.set("ses_child", "ses_a")
        const { model } = yield* server(w)
        const refused = yield* Effect.flip(model.wake("ses_child", { afterSeconds: 3, note: "n" }))
        expect(refused.reason).toContain("background shell")
        expect(w.store.entries.size).toBe(0)
        for (let index = 0; index < Model.MAX_PENDING; index += 1) yield* model.wake("ses_a", { afterSeconds: 60, note: `n${index}` })
        expect((yield* Effect.flip(model.wake("ses_a", { afterSeconds: 60, note: "one more" }))).reason).toContain("20 wakes pending")
      }),
    ))

  test("a deleted session's entries, notices and jobs go", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a", "ses_b")
        const { model } = yield* server(w)
        yield* model.wake("ses_a", { afterSeconds: 3, note: "n" })
        const other = yield* model.wake("ses_b", { afterSeconds: 3, note: "n" })
        yield* model.forget("ses_a")
        expect([...w.store.entries.keys()]).toEqual([other.entry.id])
        expect([...w.jobs.jobs.keys()]).toEqual([titleOf(other.entry.id)])
        yield* until(3 * SECOND)
        expect(inbox(w)).toEqual([])
        expect(inbox(w, "ses_b")).toHaveLength(1)
      }),
    ))
})

describe("across a reload or a stop", () => {
  test("a reload re-arms what was set, and it fires once", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        const first = yield* server(w)
        yield* first.model.wake("ses_a", { afterSeconds: 10, note: "n" })
        yield* until(4 * SECOND)
        yield* first.stop
        const second = yield* server(w)
        yield* second.model.start
        yield* until(20 * SECOND)
        expect(inbox(w)).toHaveLength(1)
        expect(texts(w)[0]).not.toContain("late")
      }),
    ))

  test("a fire recorded but cut short by the reload goes again under its id, and the session reads it once", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        const first = yield* server(w)
        const placed = yield* first.model.wake("ses_a", { afterSeconds: 1, note: "n" })
        w.sessions.refusing.set("ses_a", "reloading")
        yield* until(SECOND)
        const firing = firingOf(w.store.entries.get(placed.entry.id))
        expect(firing).toBeDefined()
        yield* first.stop
        // The message had reached the session before the reload cut the fire short of settling.
        w.sessions.refusing.delete("ses_a")
        w.sessions.inboxes.get("ses_a")?.push({ id: firing?.delivery ?? "", letter: { text: firing?.text ?? "", description: "", metadata: {} }, resume: true })
        const second = yield* server(w)
        yield* second.model.start
        yield* until(2 * MINUTE)
        expect(inbox(w).map((message) => message.id)).toEqual([firing?.delivery ?? ""])
        expect(w.store.entries.size).toBe(0)
      }),
    ))

  test("a fire that settled before the reload does not fire again", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        const first = yield* server(w)
        yield* first.model.wake("ses_a", { afterSeconds: 1, note: "n" })
        yield* until(2 * SECOND)
        yield* first.stop
        const second = yield* server(w)
        yield* second.model.start
        yield* until(2 * MINUTE)
        expect(inbox(w)).toHaveLength(1)
      }),
    ))

  test("a wake due while no server ran fires on start and says how late", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        const first = yield* server(w)
        const placed = yield* first.model.wake("ses_a", { afterSeconds: 60, note: "Check the deploy." })
        yield* first.stop
        yield* until(2 * 60 * MINUTE + MINUTE)
        expect(inbox(w)).toEqual([])
        const second = yield* server(w)
        yield* second.model.start
        yield* settle
        expect(texts(w)).toHaveLength(1)
        expect(texts(w)[0]).toContain(`⏰ Wake ${placed.entry.id} fired`)
        expect(texts(w)[0]).toContain("It fired 2h late: no OpenCode server was running at 1970-01-01T00:01:00.000Z, so it went when one started.")
        expect(texts(w)[0]).toContain("Note: Check the deploy.")
      }),
    ))

  test("a late fire on start keeps its OS job until the job's own run had time to end", () =>
    run(
      Effect.gen(function* () {
        // The start the job brought up fires the wake before the job's due call lands; removing the job then would kill it mid-call.
        const w = world("ses_a")
        const first = yield* server(w)
        const placed = yield* first.model.wake("ses_a", { afterSeconds: 30, note: "Check the deploy." })
        yield* first.stop
        yield* until(MINUTE + 5 * SECOND)
        const second = yield* server(w)
        yield* second.model.start
        yield* settle
        expect(texts(w)).toHaveLength(1)
        expect(w.jobs.jobs.has(titleOf(placed.entry.id))).toBe(true)
        expect(yield* second.model.due(placed.entry.id)).toEqual({ outcome: "gone" })
        expect(texts(w)).toHaveLength(1)
        yield* until(MINUTE + 11 * SECOND)
        expect(w.jobs.jobs.has(titleOf(placed.entry.id))).toBe(false)
      }),
    ))

  test("a repeat missed for hours fires once on start and moves to its next tick ahead", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        const first = yield* server(w)
        const placed = yield* first.model.wake("ses_a", { afterSeconds: 60, everySeconds: 3600, note: "hourly" })
        yield* first.stop
        yield* until(5 * 60 * MINUTE + 30 * MINUTE)
        const second = yield* server(w)
        yield* second.model.start
        yield* settle
        expect(texts(w)).toHaveLength(1)
        const next = w.store.entries.get(placed.entry.id)
        expect(next?.kind === "alarm" ? next.dueAt : undefined).toBe(6 * 60 * MINUTE + MINUTE)
      }),
    ))

  test("start drops the OS jobs whose entry went, registers a missing one, and arms only its own directory's entries", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a", "ses_b")
        const own: Alarm = { ...alarmFixture, id: "w0000aa", sessionID: "ses_a", directory: DIR, setAt: 0, dueAt: MINUTE }
        const elsewhere: Entry = { ...own, id: "w0000bb", sessionID: "ses_b", directory: "/work/other" }
        w.store.entries.set(own.id, own)
        w.store.entries.set(elsewhere.id, elsewhere)
        const job = (id: string) => ({ job: { id, title: titleOf(id), directory: DIR }, schedule: oneShot(MINUTE) })
        w.jobs.jobs.set(titleOf("w0000zz"), job("w0000zz"))
        w.jobs.jobs.set(titleOf(elsewhere.id), job(elsewhere.id))
        w.jobs.jobs.set("nightly-report", job("nightly"))
        const { model } = yield* server(w)
        yield* model.start
        expect([...w.jobs.jobs.keys()].toSorted()).toEqual(["nightly-report", titleOf(own.id), titleOf(elsewhere.id)].toSorted())
        yield* until(2 * MINUTE)
        expect(inbox(w)).toHaveLength(1)
        expect(inbox(w, "ses_b")).toEqual([])
        expect(w.store.entries.has(elsewhere.id)).toBe(true)
      }),
    ))
})

describe("the OS backstop's due call", () => {
  test("fires a due alarm once, and drops its job after the job's run had time to end", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        const first = yield* server(w)
        const placed = yield* first.model.wake("ses_a", { afterSeconds: 60, note: "n" })
        yield* first.stop
        yield* until(MINUTE)
        // The OS job started OpenCode, whose server had not armed it yet.
        const { model } = yield* server(w)
        expect(yield* model.due(placed.entry.id)).toEqual({ outcome: "fired" })
        expect(inbox(w)).toHaveLength(1)
        expect(w.jobs.jobs.has(titleOf(placed.entry.id))).toBe(true)
        yield* until(MINUTE + 5 * SECOND)
        expect(w.jobs.jobs.has(titleOf(placed.entry.id))).toBe(false)
        yield* model.start
        expect(yield* model.due(placed.entry.id)).toEqual({ outcome: "gone" })
        yield* until(2 * MINUTE)
        expect(inbox(w)).toHaveLength(1)
      }),
    ))

  test("a racing timer and due call deliver one message", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        const { model } = yield* server(w)
        const placed = yield* model.wake("ses_a", { afterSeconds: 60, note: "n" })
        yield* TestClock.adjust(MINUTE)
        const outcome = yield* model.due(placed.entry.id)
        yield* settle
        expect(["fired", "gone"]).toContain(outcome.outcome)
        expect(inbox(w)).toHaveLength(1)
      }),
    ))

  test("answers pending before its time, for a monitor, and for another directory's entry; gone for an unknown id, dropping its job", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        w.checks.answers.set("true", [MemoryChecks.check(1)])
        const { model } = yield* server(w)
        const early = yield* model.wake("ses_a", { afterSeconds: 120, note: "n" })
        const watching = yield* model.monitor("ses_a", { command: "true", note: "n" })
        w.store.entries.set("w0000cc", { ...early.entry, id: "w0000cc", directory: "/work/other" })
        expect(yield* model.due(early.entry.id)).toEqual({ outcome: "pending" })
        expect(yield* model.due(watching.entry.id)).toEqual({ outcome: "pending" })
        expect(yield* model.due("w0000cc")).toEqual({ outcome: "pending" })
        w.jobs.jobs.set(titleOf("w0000zz"), { job: { id: "w0000zz", title: titleOf("w0000zz"), directory: DIR }, schedule: oneShot(0) })
        expect(yield* model.due("w0000zz")).toEqual({ outcome: "gone" })
        yield* until(5 * SECOND)
        expect(w.jobs.jobs.has(titleOf("w0000zz"))).toBe(false)
        expect(inbox(w)).toEqual([])
      }),
    ))
})

describe("a latch", () => {
  const ask: LatchAsk = {
    sessionID: "ses_a",
    subagent: latchFixture.subagent,
    hold: "pace",
    reason: "anthropic is at 92% of its 5h window",
    opensAt: 10 * MINUTE,
    recheckAt: 2 * MINUTE,
    context: { background: false },
  }
  const childOf = (w: World, sessionID: string) => w.sessions.children.get(sessionID)

  test("latched: it is kept as the parent's, its child made unprompted with its mark, and its time guarded", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        w.opener.answer = () => ({ outcome: "opened" })
        const { model } = yield* server(w)
        const latched = yield* model.latch(ask)
        expect(childOf(w, latched.child)).toEqual({
          sessionID: latched.child,
          parentID: "ses_a",
          directory: DIR,
          title: "Add the export",
          agent: "implementor",
          model: "anthropic/claude-opus#high",
          mark: { hold: "pace", reason: ask.reason, opensAt: 10 * MINUTE, at: 0 },
        })
        expect(w.sessions.started.get(latched.child)).toBeUndefined()
        expect(w.jobs.jobs.get(titleOf(latched.id))?.schedule).toEqual(oneShot(10 * MINUTE))
        expect((yield* model.pending(["ses_a"])).entries).toEqual([
          { id: latched.id, kind: "latch", sessionID: "ses_a", mode: "wake", note: "Add the export", dueAt: 10 * MINUTE, setAt: 0, child: latched.child },
        ])
        expect(w.changed).toContain("ses_a")
        yield* until(2 * MINUTE - SECOND)
        expect(w.opener.asked).toEqual([])
      }),
    ))

  test("re-latched: a recheck still held keeps it with the new reason and time, and asks again then and not before", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        const answers = [
          { outcome: "held" as const, hold: "pace" as const, reason: "anthropic is at 95% of its 5h window", opensAt: 20 * MINUTE, recheckAt: 4 * MINUTE },
          { outcome: "opened" as const },
        ]
        w.opener.answer = () => answers.shift() ?? { outcome: "opened" }
        const { model } = yield* server(w)
        const latched = yield* model.latch(ask)
        yield* until(2 * MINUTE)
        expect(w.opener.asked).toHaveLength(1)
        const held = w.store.entries.get(latched.id)
        expect(held?.kind === "latch" ? [held.reason, held.opensAt, held.recheckAt] : undefined).toEqual(["anthropic is at 95% of its 5h window", 20 * MINUTE, 4 * MINUTE])
        expect(childOf(w, latched.child)?.mark).toEqual({ hold: "pace", reason: "anthropic is at 95% of its 5h window", opensAt: 20 * MINUTE, at: 0 })
        expect(w.jobs.jobs.get(titleOf(latched.id))?.schedule).toEqual(oneShot(20 * MINUTE))
        yield* until(4 * MINUTE - SECOND)
        expect(w.opener.asked).toHaveLength(1)
        yield* until(4 * MINUTE)
        expect(w.opener.asked).toHaveLength(2)
      }),
    ))

  test("opened: at its time the opener starts it, and the latch, its job and the child's mark go", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        w.opener.answer = () => ({ outcome: "opened" })
        const { model } = yield* server(w)
        const latched = yield* model.latch({ ...ask, hold: "sabbath", reason: "It is the Sabbath", recheckAt: 10 * MINUTE })
        yield* until(10 * MINUTE)
        expect(w.opener.asked.map((asked) => [asked.id, asked.child, asked.subagent.prompt])).toEqual([[latched.id, latched.child, ask.subagent.prompt]])
        expect(w.store.entries.has(latched.id)).toBe(false)
        expect(childOf(w, latched.child)?.mark).toBeUndefined()
        yield* until(10 * MINUTE + 6 * SECOND)
        expect(w.jobs.jobs.has(titleOf(latched.id))).toBe(false)
        expect(inbox(w)).toEqual([])
      }),
    ))

  test("cancelled: wake_cancel drops it and its job, its child reads cancelled, and it never opens", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        w.opener.answer = () => ({ outcome: "opened" })
        const { model } = yield* server(w)
        const latched = yield* model.latch(ask)
        yield* until(30 * SECOND)
        expect(yield* model.cancel("ses_a", latched.id)).toEqual([latched.id])
        expect(w.store.entries.has(latched.id)).toBe(false)
        expect(w.jobs.jobs.has(titleOf(latched.id))).toBe(false)
        expect(childOf(w, latched.child)?.mark).toEqual({ hold: "pace", reason: ask.reason, opensAt: 10 * MINUTE, at: 0, cancelledAt: 30 * SECOND })
        yield* until(20 * MINUTE)
        expect(w.opener.asked).toEqual([])
      }),
    ))

  test("survives a restart: kept across a stop, it opens on the next start once its time passed while no server ran", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        w.opener.answer = () => ({ outcome: "opened" })
        const first = yield* server(w)
        const latched = yield* first.model.latch(ask)
        yield* first.stop
        yield* until(15 * MINUTE)
        expect(w.opener.asked).toEqual([])
        expect(w.store.entries.has(latched.id)).toBe(true)
        const second = yield* server(w)
        yield* second.model.start
        yield* until(15 * MINUTE + SECOND)
        expect(w.opener.asked.map((asked) => asked.id)).toEqual([latched.id])
        expect(w.store.entries.has(latched.id)).toBe(false)
      }),
    ))

  test("an opener not reachable yet is asked again shortly", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        const { model } = yield* server(w)
        const latched = yield* model.latch(ask)
        yield* until(2 * MINUTE)
        expect(w.opener.asked).toHaveLength(1)
        w.opener.answer = () => ({ outcome: "opened" })
        yield* until(2 * MINUTE + OPEN_RETRY_MS)
        expect(w.opener.asked).toHaveLength(2)
        expect(w.store.entries.has(latched.id)).toBe(false)
      }),
    ))

  test("failed: it goes, its child reads failed, and its parent is told why", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        w.opener.answer = () => ({ outcome: "failed", message: "Unknown agent: implementor" })
        const { model } = yield* server(w)
        const latched = yield* model.latch(ask)
        yield* until(2 * MINUTE)
        expect(w.store.entries.has(latched.id)).toBe(false)
        expect(childOf(w, latched.child)?.mark?.failed).toBe("Unknown agent: implementor")
        expect(inbox(w)).toHaveLength(1)
        expect(inbox(w)[0]?.resume).toBe(true)
        expect(texts(w)[0]).toContain(`Latch ${latched.id} could not start its subagent: Unknown agent: implementor`)
      }),
    ))

  test("a parent that does not exist is refused, and nothing is kept; a deleted child takes its latch with it", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        const { model } = yield* server(w)
        expect((yield* Effect.flip(model.latch({ ...ask, sessionID: "ses_gone" }))).reason).toContain("could not be made")
        expect(w.store.entries.size).toBe(0)
        const latched = yield* model.latch(ask)
        yield* model.forget(latched.child)
        expect(w.store.entries.size).toBe(0)
        expect(w.jobs.jobs.has(titleOf(latched.id))).toBe(false)
      }),
    ))
})

describe("a job", () => {
  test("drips its progress at most once a minute without a turn, and its end, seen by the poll, steers one letter with the exit, log tail and note", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        const { model } = yield* server(w)
        const { job, launched } = yield* model.job("ses_a", { command: "bun test", note: "Read the failures." })
        expect(job.id).toMatch(/^j[0-9a-z]{6}$/)
        expect(launched.how).toBe("detached")
        expect(w.runner.jobs.get(job.id)?.spec).toMatchObject({ command: "bun test", cwd: DIR, sessionID: "ses_a" })
        const memory = w.runner.jobs.get(job.id)
        if (memory === undefined) throw new Error("not launched")
        MemoryRunner.running(w.runner, job.id, 0)
        memory.drip = "compiled\nhalf"
        yield* until(MINUTE + 10 * SECOND)
        expect(inbox(w).map((message) => [message.resume, message.letter.text.split("\n")[1]])).toEqual([[false, "compiled"]])
        memory.drip = "compiled\nhalf done\nlinked\n"
        yield* until(MINUTE + 30 * SECOND)
        expect(inbox(w)).toHaveLength(1)
        memory.log = "2 pass\n1 fail\n"
        MemoryRunner.ended(w.runner, job.id, 1, 100 * SECOND)
        yield* until(2 * MINUTE)
        const letters = inbox(w)
        expect(letters).toHaveLength(2)
        expect(letters[1]?.resume).toBe(true)
        expect(letters[1]?.letter.text).toStartWith(`⏰ Job ${job.id} exited 1 after 2m: \`bun test\`.`)
        // What progress came after the last drip rides on the end letter.
        expect(letters[1]?.letter.text).toContain("Progress ($JOB_DRIP):\nhalf done\nlinked")
        expect(letters[1]?.letter.text).toContain("1 fail")
        expect(letters[1]?.letter.text).toContain("Note: Read the failures.")
        expect(w.store.entries.size).toBe(0)
        yield* until(5 * MINUTE)
        expect(inbox(w)).toHaveLength(2)
      }),
    ))

  test("one that ended while no server ran fires at the next start, saying how late", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        const first = yield* server(w)
        const { job } = yield* first.model.job("ses_a", { command: "make", note: "n" })
        MemoryRunner.running(w.runner, job.id, 0)
        yield* first.stop
        MemoryRunner.ended(w.runner, job.id, 0, 5 * MINUTE)
        yield* until(10 * MINUTE)
        expect(inbox(w)).toHaveLength(0)
        const { model } = yield* server(w)
        yield* model.start
        yield* settle
        expect(texts(w)).toHaveLength(1)
        expect(texts(w)[0]).toContain(`Job ${job.id} exited 0`)
        expect(texts(w)[0]).toContain("no OpenCode server was running then")
      }),
    ))

  test("one whose runner never came up reads lost past the grace, and still wakes its session", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        const { model } = yield* server(w)
        const { job } = yield* model.job("ses_a", { command: "make", note: "n" })
        yield* until(MINUTE)
        expect(texts(w)).toHaveLength(1)
        expect(texts(w)[0]).toContain(`Job ${job.id} was lost: it never started`)
      }),
    ))

  test("wake_cancel refuses a job and names the kill; a deleted session's job is killed; a refused launch keeps nothing", () =>
    run(
      Effect.gen(function* () {
        const w = world("ses_a")
        const { model } = yield* server(w)
        const { job } = yield* model.job("ses_a", { command: "sleep 999", note: "n" })
        MemoryRunner.running(w.runner, job.id, 0)
        const refused = yield* Effect.flip(model.cancel("ses_a", job.id))
        expect(refused.reason).toContain(`job({ action: "kill", id: "${job.id}" })`)
        yield* model.forget("ses_a")
        expect(w.runner.killed).toEqual([job.id])
        expect(w.store.entries.size).toBe(0)
        w.runner.refusing = "no bun"
        expect((yield* Effect.flip(model.job("ses_a", { command: "true", note: "n" }))).reason).toBe("the job did not start: no bun")
        expect(w.store.entries.size).toBe(0)
      }),
    ))
})
