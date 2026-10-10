import { Array as Arr, Option, Result } from "effect"
import { describe, expect, test } from "effect-bun-test"
import * as Decide from "../src/domain/decide.js"
import { Event } from "../src/domain/event.js"
import type { Entry } from "../src/domain/event.js"
import * as State from "../src/domain/state.js"
import type { Run } from "../src/domain/state.js"

const MIN = 60_000
const orch = { name: "hymn-orch", pane: "w:p0" }
const impl = { name: "hymn-src-impl", pane: "w:p1" }
const rev = { name: "hymn-src-rev", pane: "w:p2" }
const ver = { name: "hymn-src-ver", pane: "w:p3" }

/** A log: each event one minute after the last, unless it says when. */
const log = (...events: ReadonlyArray<Event | readonly [number, Event]>): ReadonlyArray<Entry> =>
  events.map((item, index) => {
    if (Array.isArray(item)) return { seq: index + 1, at: item[0], event: item[1] }
    return { seq: index + 1, at: (index + 1) * MIN, event: item }
  })

const runOf = (entries: ReadonlyArray<Entry>): Run =>
  Option.getOrThrow(State.project("hymn", entries))

const started = Event.cases.RunStarted.make({ root: "/runs/hymn", orchestrator: orch })
const opened = (verifier: boolean) =>
  Event.cases.TrackOpened.make({
    unit: "src",
    cwd: "/work/src",
    tab: "w:t1",
    impl,
    rev,
    ver: Option.liftPredicate(ver, () => verifier),
    spec: "/runs/hymn/src/spec.md",
    maxFailures: 3,
  })
const submitted = (n: number) =>
  Event.cases.RoundSubmitted.make({
    unit: "src",
    request: `/r/round-${n}-request.md`,
    head: `c${n}`,
  })
const reviewed = (verdict: "accepted" | "changes" | "stuck", n = 1) =>
  Event.cases.ReviewFiled.make({ unit: "src", verdict, findings: `/r/round-${n}-findings.md` })
const verified = (verdict: "pass" | "fail" | "stuck") =>
  Event.cases.VerificationFiled.make({ unit: "src", verdict, report: "/r/round-1-verify.md" })

const track = (run: Run): State.Track =>
  Option.getOrThrow(Option.fromUndefinedOr(run.tracks.get("src")))
const holderAfter = (...events: ReadonlyArray<Event>): string =>
  track(runOf(log(started, ...events))).step.holder
const delivered = (ref: number) => [
  Event.cases.DeliveryStarted.make({ ref }),
  Event.cases.DeliveryFinished.make({ ref, failure: Option.none() }),
]
const lastMessage = (run: Run): State.Message =>
  Option.getOrThrow(Arr.last([...run.messages.values()]))

describe("the baton", () => {
  test("moves along implementor, reviewer, verifier, orchestrator", () => {
    expect(holderAfter(opened(true))).toBe("impl")
    expect(holderAfter(opened(true), submitted(1))).toBe("rev")
    expect(holderAfter(opened(true), submitted(1), reviewed("changes"))).toBe("impl")
    expect(holderAfter(opened(true), submitted(1), reviewed("accepted"))).toBe("ver")
    expect(holderAfter(opened(false), submitted(1), reviewed("accepted"))).toBe("orch")
    expect(holderAfter(opened(true), submitted(1), reviewed("accepted"), verified("fail"))).toBe(
      "impl",
    )
    expect(holderAfter(opened(true), submitted(1), reviewed("accepted"), verified("pass"))).toBe(
      "orch",
    )
  })

  test("each step sends its holder one line naming the file", () => {
    const run = runOf(log(started, opened(false), submitted(1)))
    expect(lastMessage(run)).toMatchObject({
      to: rev,
      text: "[hymn-src] round 1 ready for review: /r/round-1-request.md",
      delivery: { state: "pending" },
    })
    const kickoff = Option.getOrThrow(Option.fromUndefinedOr(run.messages.get(2)))
    expect(kickoff.to).toEqual(impl)
    expect(kickoff.text).toContain("/runs/hymn/src/spec.md")
  })

  test("the third failed round is stuck, and goes to the orchestrator", () => {
    const run = runOf(
      log(
        started,
        opened(true),
        submitted(1),
        reviewed("changes", 1),
        submitted(2),
        reviewed("accepted", 2),
        verified("fail"),
        submitted(3),
        reviewed("changes", 3),
      ),
    )
    expect(track(run).step).toMatchObject({ kind: "stuck", holder: "orch" })
    expect(lastMessage(run).to).toEqual(orch)
    expect(lastMessage(run).text).toContain("failure 3 of 3")
  })

  test("a note hands the baton to its worker; a question hands it back", () => {
    const note = Event.cases.NoteSent.make({
      unit: "src",
      to: "impl",
      text: "merge main, resubmit",
    })
    const asked = Event.cases.QuestionAsked.make({ unit: "src", by: "impl", note: "/r/q.md" })
    expect(holderAfter(opened(false), submitted(1), reviewed("accepted"), note)).toBe("impl")
    expect(holderAfter(opened(false), asked)).toBe("orch")
  })
})

describe("passing", () => {
  const run = runOf(log(started, opened(true), submitted(1)))
  const seat = (pane: string) => Option.getOrThrow(State.seatOf(run, pane))
  const input = (verdict: Option.Option<string>) => ({
    file: "/r/f.md",
    verdict,
    head: Option.some("c2"),
  })

  test("a pane's seat comes from the log", () => {
    expect(seat(rev.pane).role).toBe("rev")
    expect(Option.isNone(State.seatOf(run, "w:p9"))).toBe(true)
  })

  test("only the holder passes, and with its role's verdicts", () => {
    const refused = Decide.pass(seat(impl.pane), input(Option.none()))
    expect(Result.isFailure(refused) && refused.failure.reason).toContain(
      "the baton is with the rev",
    )
    expect(Result.isFailure(Decide.pass(seat(rev.pane), input(Option.some("pass"))))).toBe(true)
    expect(Result.isFailure(Decide.pass(seat(rev.pane), input(Option.none())))).toBe(true)
    const filed = Decide.pass(seat(rev.pane), input(Option.some("changes")))
    expect(Result.getOrThrow(filed)).toEqual(
      Event.cases.ReviewFiled.make({ unit: "src", verdict: "changes", findings: "/r/f.md" }),
    )
  })

  test("a unit's agent names fit herdr's 32 characters", () => {
    expect(Result.isSuccess(Decide.canOpen(run, "deck-b", "/work/deck-b"))).toBe(true)
    expect(Result.isFailure(Decide.canOpen(run, "src", "/work/src2"))).toBe(true)
    expect(Result.isFailure(Decide.canOpen(run, "a-very-long-unit-name-indeed", "/work/x"))).toBe(
      true,
    )
    expect(Result.isFailure(Decide.canOpen(run, "Bad", "/work/bad"))).toBe(true)
  })

  test("each open track has its own workspace", () => {
    const shared = Decide.canOpen(run, "deck-b", "/work/src")
    const reason = Result.match(shared, {
      onSuccess: () => "",
      onFailure: (error) => error.message,
    })
    expect(reason).toContain("own workspace")
  })
})

describe("delivery", () => {
  test("a message is sent once, retried only after a crash mid-send", () => {
    const base = [started, opened(false)] as const
    const pending = runOf(log(...base))
    expect(State.deliverable(pending, 2 * MIN).map((m) => m.ref)).toEqual([2])
    const sending = runOf(log(...base, Event.cases.DeliveryStarted.make({ ref: 2 })))
    expect(State.deliverable(sending, 3 * MIN)).toEqual([])
    expect(State.deliverable(sending, 3 * MIN + State.DELIVERY_RETRY_MS).map((m) => m.ref)).toEqual(
      [2],
    )
    const done = runOf(
      log(
        ...base,
        Event.cases.DeliveryStarted.make({ ref: 2 }),
        Event.cases.DeliveryFinished.make({ ref: 2, failure: Option.none() }),
      ),
    )
    expect(State.deliverable(done, 60 * MIN)).toEqual([])
  })

  test("a failed message tells the orchestrator, and redelivery sends it again", () => {
    const failed = runOf(
      log(
        started,
        opened(false),
        Event.cases.DeliveryStarted.make({ ref: 2 }),
        Event.cases.DeliveryFinished.make({ ref: 2, failure: Option.some("agent_blocked") }),
      ),
    )
    expect(lastMessage(failed).to).toEqual(orch)
    expect(lastMessage(failed).text).toContain("baton redeliver 2")
    const again = Result.getOrThrow(Decide.redeliver(failed, 2))
    const retried = runOf(
      log(
        started,
        opened(false),
        Event.cases.DeliveryStarted.make({ ref: 2 }),
        Event.cases.DeliveryFinished.make({ ref: 2, failure: Option.some("agent_blocked") }),
        again,
      ),
    )
    expect(State.deliverable(retried, 10 * MIN).map((m) => m.ref)).toContain(2)
  })

  const fail = (ref: number, why = "agent_blocked: at a dialog") => [
    Event.cases.DeliveryStarted.make({ ref }),
    Event.cases.DeliveryFinished.make({ ref, failure: Option.some(why) }),
  ]
  const seen = (status: "idle" | "blocked") =>
    Event.cases.AgentsObserved.make({
      statuses: { [orch.name]: "idle", [impl.name]: status, [rev.name]: "idle" },
    })
  const toOrch = (run: Run): ReadonlyArray<string> =>
    [...run.messages.values()].flatMap((m) =>
      Option.toArray(Option.liftPredicate(m.text, () => m.to.name === orch.name)),
    )

  test("a failed message is resent once herdr reports its recipient idle", () => {
    const failed = [started, opened(false), ...fail(2)] as const
    expect(State.resendable(runOf(log(...failed)))).toEqual([])
    expect(State.resendable(runOf(log(...failed, seen("blocked"))))).toEqual([])
    expect(State.resendable(runOf(log(...failed, seen("blocked"), seen("idle"))))).toEqual([2])
    const resent = [
      ...failed,
      seen("idle"),
      Event.cases.RedeliveryRequested.make({ ref: 2 }),
      ...fail(2),
    ]
    expect(State.resendable(runOf(log(...resent)))).toEqual([])
    expect(State.resendable(runOf(log(...resent, seen("blocked"), seen("idle"))))).toEqual([2])
  })

  test("the orchestrator hears the reason, the landing, and when baton gives up", () => {
    const failed = runOf(log(started, opened(false), ...fail(2)))
    expect(toOrch(failed)).toEqual([
      "[baton] could not deliver #2 to hymn-src-impl: agent_blocked: at a dialog. " +
        "baton sends it again when herdr next reports hymn-src-impl idle; " +
        "to send it sooner: baton redeliver 2",
    ])
    const landed = runOf(
      log(
        started,
        opened(false),
        ...fail(2),
        Event.cases.RedeliveryRequested.make({ ref: 2 }),
        ...delivered(2),
      ),
    )
    expect(toOrch(landed).at(-1)).toBe("[baton] #2 reached hymn-src-impl after 1 attempt failed")
    const again = [Event.cases.RedeliveryRequested.make({ ref: 2 }), ...fail(2)]
    const exhausted = runOf(
      log(started, opened(false), ...fail(2), ...again, ...again, ...again, seen("idle")),
    )
    expect(Option.getOrThrow(Option.fromUndefinedOr(exhausted.messages.get(2))).failures).toBe(
      State.RESENDS + 1,
    )
    expect(State.resendable(exhausted)).toEqual([])
    expect(toOrch(exhausted)).toHaveLength(2)
    expect(toOrch(exhausted)[1]).toContain("4 attempts failed, and baton has stopped resending it")
  })

  test("a closed track's workers get nothing more", () => {
    const closed = runOf(
      log(
        started,
        opened(false),
        Event.cases.TrackClosed.make({ unit: "src", merged: Option.none() }),
      ),
    )
    expect(State.deliverable(closed, 10 * MIN)).toEqual([])
  })
})

describe("stalls", () => {
  const observed = (statuses: Record<string, "idle" | "working" | "blocked">) =>
    Event.cases.AgentsObserved.make({ statuses: { [orch.name]: "idle", ...statuses } })

  test("a quiet track stalls after 10 minutes, and is reported once per step", () => {
    const quiet = log(started, opened(false), ...delivered(2), [
      5 * MIN,
      observed({ [impl.name]: "idle", [rev.name]: "idle" }),
    ])
    expect(State.stalls(runOf(quiet), 14 * MIN)).toEqual([])
    expect(State.stalls(runOf(quiet), 15 * MIN)).toEqual([{ unit: "src", stall: "quiet", step: 2 }])
    const reported = [
      ...quiet,
      {
        seq: 7,
        at: 15 * MIN,
        event: Event.cases.StallDetected.make({ unit: "src", stall: "quiet", step: 2 }),
      },
    ]
    expect(State.stalls(runOf(reported), 30 * MIN)).toEqual([])
    expect(lastMessage(runOf(reported)).text).toContain("[watchdog] hymn-src: every agent")
  })

  test("a working track never stalls; a gone or dialog-bound holder does", () => {
    const working = log(
      started,
      opened(false),
      ...delivered(2),
      observed({ [impl.name]: "working", [rev.name]: "idle" }),
    )
    expect(State.stalls(runOf(working), 60 * MIN)).toEqual([])
    const gone = log(started, opened(false), ...delivered(2), observed({ [rev.name]: "idle" }))
    expect(State.stalls(runOf(gone), 5 * MIN).map((s) => s.stall)).toEqual(["gone"])
    const dialog = log(started, opened(false), ...delivered(2), [
      5 * MIN,
      observed({ [impl.name]: "blocked", [rev.name]: "idle" }),
    ])
    expect(State.stalls(runOf(dialog), 6 * MIN)).toEqual([])
    expect(State.stalls(runOf(dialog), 7 * MIN).map((s) => s.stall)).toEqual(["dialog"])
  })

  test("a message still on its way to the holder is not a stall", () => {
    const undelivered = log(started, opened(false), [
      2 * MIN,
      observed({ [impl.name]: "idle", [rev.name]: "idle" }),
    ])
    expect(State.stalls(runOf(undelivered), 60 * MIN)).toEqual([])
  })
})
