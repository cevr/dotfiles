// The hand-off of the TUI's environment through a server restart: every
// member of a family of 300 asks for a hand while the server resets each
// connection, as an install's restart does. A reset is tried again until the
// server answers, and what fails for good is one warning for the burst, not
// one per member (the owner saw 303 stacked). Driven by a clock the test
// advances, through the follower the TUI runs (`handFamily`).
import { describe, expect, test } from "bun:test"
import { Array as Arr, Effect, Option } from "effect"
// The fork's own class, so a rename of its name or reason upstream turns these tests red.
import { ClientError } from "@opencode/client"
import { createEffect, createRoot, createSignal } from "solid-js/dist/solid.js"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { handFamily, type HandHost, type Reads } from "./family.ts"
import { type Clock, HandFailed, isTransport, QUIET_MS, RETRY_FOR_MS, RETRY_MAX_MS } from "./hand.ts"
import { hangGuard } from "../../../tests/hang-guard.ts"



const RESET_TEXT = "ECONNRESET: Unable to connect. Is the computer able to access the url?"
const reset = Effect.fail(new HandFailed({ transport: true, message: `ClientError: Transport: ${RESET_TEXT}` }))

/** A clock the test drives: `advance` runs each timer as its time comes, letting what it starts settle. */
const drivenClock = () => {
  const state = { now: 0, next: 0 }
  const timers = new Map<number, { readonly at: number; readonly run: () => void }>()
  const clock: Clock = {
    now: () => state.now,
    after: (ms, run) => {
      const id = state.next++
      timers.set(id, { at: state.now + ms, run })
      return () => timers.delete(id)
    },
  }
  const settle = Effect.repeat(Effect.yieldNow, { times: 3 })
  /** The earliest timer due by `end`, if any. */
  const dueBy = (end: number) =>
    Arr.reduce([...timers.entries()], Option.none<readonly [number, { readonly at: number; readonly run: () => void }]>(), (earliest, entry) =>
      Option.match(
        Option.filter(earliest, ([, timer]) => timer.at <= entry[1].at),
        {
          onSome: () => earliest,
          onNone: () => Option.liftPredicate(entry, ([, timer]) => timer.at <= end),
        },
      ),
    )
  const advance = (ms: number) =>
    Effect.gen(function* () {
      const end = state.now + ms
      yield* settle
      for (let due = dueBy(end); Option.isSome(due); due = dueBy(end)) {
        const [id, timer] = due.value
        timers.delete(id)
        state.now = timer.at
        timer.run()
        yield* settle
      }
      state.now = end
      yield* settle
    })
  return { clock, advance }
}

const ROOT = "ses_root"
const members = (count: number) => Array.from({ length: count }, (_, index) => `ses_${index}`)

/** A family under ROOT, the root on screen, its members a signal, every one running. */
const family = () => {
  const [ids, setIds] = createSignal<ReadonlyArray<string>>([ROOT])
  const reads: Reads = {
    session: { root: () => ROOT, family: () => ids(), status: () => "running" },
  }
  return { reads, setIds }
}

/** Runs the follower over `reads` with `environment` as the client's, and collects the warnings. */
const follow = (reads: Reads, environment: HandHost["environment"], clock: Clock) => {
  const warnings: Array<{ readonly title: string; readonly message: string }> = []
  const stop = createRoot((dispose) => {
    const stopHands = handFamily(
      reads,
      () => ({ type: "session", sessionID: ROOT }),
      { environment, warn: (title, message) => warnings.push({ title, message }) },
      clock,
      createEffect,
    )
    return () => {
      stopHands()
      dispose()
    }
  })
  return { warnings, stop }
}

describe("a server restart while 300 subagents ask for the pane", () => {
  effectTest(
    "a connection reset is tried again until the server answers: every member handed, no warning",
    Effect.gen(function* () {
      const { clock, advance } = drivenClock()
      const { reads, setIds } = family()
      const resets = new Map<string, number>()
      const handed = new Set<string>()
      const environment = (sessionID: string) =>
        Effect.suspend(() => {
          const count = resets.get(sessionID) ?? 0
          if (count < 4) {
            resets.set(sessionID, count + 1)
            return reset
          }
          handed.add(sessionID)
          return Effect.void
        })
      const { warnings, stop } = follow(reads, environment, clock)
      setIds([ROOT, ...members(300)])
      yield* advance(2 * 60_000)
      expect(handed.size).toBe(300)
      expect(warnings).toEqual([])
      stop()
    }),
    hangGuard("local-fixture"),
  )

  effectTest(
    "a server that refuses every hand: exactly one warning for the burst, with the count and the first error",
    Effect.gen(function* () {
      const { clock, advance } = drivenClock()
      const { reads, setIds } = family()
      const refuse = Effect.fail(new HandFailed({ transport: false, message: "ClientError: UnexpectedStatus: 500" }))
      const { warnings, stop } = follow(reads, () => refuse, clock)
      setIds([ROOT, ...members(300)])
      yield* advance(10 * QUIET_MS)
      expect(warnings).toEqual([
        {
          title: "Rex pane not handed to 300 subagents",
          message: "ClientError: UnexpectedStatus: 500",
        },
      ])
      stop()
    }),
    hangGuard("local-fixture"),
  )

  effectTest(
    "a server that never comes back: one warning once the retries give up, none before",
    Effect.gen(function* () {
      const { clock, advance } = drivenClock()
      const { reads, setIds } = family()
      const tries = { count: 0 }
      const { warnings, stop } = follow(reads, () => Effect.suspend(() => ((tries.count += 1), reset)), clock)
      setIds([ROOT, ...members(300)])
      yield* advance(RETRY_FOR_MS - RETRY_MAX_MS)
      expect(warnings).toEqual([])
      yield* advance(2 * RETRY_MAX_MS + QUIET_MS)
      expect(warnings).toEqual([
        {
          title: "Rex pane not handed to 300 subagents",
          message: `ClientError: Transport: ${RESET_TEXT}`,
        },
      ])
      // A backoff, not a hammer: each member tried a few dozen times over the bound.
      expect(tries.count).toBeLessThan(300 * 40)
      stop()
    }),
    hangGuard("local-fixture"),
  )

  effectTest(
    "a member asking again while its hand waits to be retried is the same hand",
    Effect.gen(function* () {
      const { clock, advance } = drivenClock()
      const [running, setRunning] = createSignal(true)
      const status = () =>
        Option.match(Option.liftPredicate(running(), Boolean), {
          onSome: () => "running" as const,
          onNone: () => "idle" as const,
        })
      const reads: Reads = { session: { root: () => ROOT, family: () => [ROOT, "ses_a"], status } }
      const sends: Array<string> = []
      const answers = [reset, Effect.void]
      const { warnings, stop } = follow(
        reads,
        (sessionID) =>
          Effect.suspend(() => {
            sends.push(sessionID)
            return Option.getOrElse(Option.fromUndefinedOr(answers.shift()), () => Effect.void)
          }),
        clock,
      )
      yield* advance(0)
      // Runs again while its first hand waits out the backoff.
      setRunning(false)
      setRunning(true)
      yield* advance(60_000)
      expect(sends).toEqual(["ses_a", "ses_a"])
      expect(warnings).toEqual([])
      stop()
    }),
    hangGuard("local-fixture"),
  )
})

describe("a client failure as a hand's", () => {
  test("the client failing to reach the server is a transport failure, tried again", () => {
    expect(isTransport(new ClientError("Transport", { detail: RESET_TEXT }))).toBe(true)
  })

  test("the server answering with an error, or any other failure, is a refusal, told", () => {
    expect(isTransport(new ClientError("UnexpectedStatus", { detail: "500" }))).toBe(false)
    expect(isTransport({ name: "OtherError", reason: "Transport" })).toBe(false)
    expect(isTransport("ClientError: Transport: ECONNRESET")).toBe(false)
  })
})
