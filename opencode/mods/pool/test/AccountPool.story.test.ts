// The AccountPool aggregate's stories: a request is placed on the run's pin
// or the best account, a reading or a refusal holds an account, a step counts
// on its account, a run ends, and the ledger forgets what has expired.
import { describe, test } from "bun:test"
import { Effect } from "effect"
import * as Story from "../../../lib/story.ts"
import { CACHE_LIFE_MS, DEFAULT_HOLD_MS, PIN_IDLE_MS, WINDOW_MS, type RequestKind } from "../src/domain/Accounts.ts"
import { AccountPool } from "../src/domain/AccountPool/AccountPool.aggregate.ts"
import { ListLogins, LoginsListed } from "../src/domain/AccountPool/ListLogins.command.ts"
import { NoAccount, PlaceRequest, RequestPlaced } from "../src/domain/AccountPool/PlaceRequest.command.ts"
import { LedgerPruned, PruneLedger } from "../src/domain/AccountPool/PruneLedger.command.ts"
import { RecordStep, StepRecorded } from "../src/domain/AccountPool/RecordStep.command.ts"
import { RefuseRequest, RequestRefused } from "../src/domain/AccountPool/RefuseRequest.command.ts"
import { ReleaseRun, RunReleased } from "../src/domain/AccountPool/ReleaseRun.command.ts"
import { ReadingTaken, TakeReading } from "../src/domain/AccountPool/TakeReading.command.ts"
import type { QuotaReading } from "../src/domain/Quota.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const T0 = 1_800_000_000_000

const story = Story.make(AccountPool)
const run = (...steps: Parameters<typeof story>) => Effect.runPromise(story(...steps))

const accounts = (...credentials: ReadonlyArray<string>) => Story.given(LoginsListed.make({ credentials }))
const reading = (fields: Partial<QuotaReading> = {}): QuotaReading => ({ at: T0, windows: [], ...fields })

/** Place a request of `sessionID` and assert the account it goes out on, at `at`. */
const placed = (sessionID: string, credentialID: string, at: number, kind: RequestKind = "primary") =>
  [
    Story.when(PlaceRequest.make({ sessionID, kind })),
    Story.then(RequestPlaced.make({ sessionID, kind, credentialID, at })),
  ] as const

/** Take a reading that sets no hold. */
const read = (credentialID: string, value: QuotaReading) =>
  [Story.when(TakeReading.make({ credentialID, reading: value })), Story.then(ReadingTaken.make({ credentialID, reading: value }))] as const

/** Record a priced step of `sessionID` on `credentialID`. */
const stepped = (sessionID: string, credentialID: string, cost: number, at: number) =>
  [
    Story.when(RecordStep.make({ sessionID, cost })),
    Story.then(StepRecorded.make({ step: { at, sessionID, credentialID, cost } })),
  ] as const

const released = (sessionID: string) =>
  [Story.when(ReleaseRun.make({ sessionID })), Story.then(RunReleased.make({ sessionID }))] as const

describe("the pool's accounts", () => {
  test("are the logins as listed, recorded only when they change", () =>
    run(
      Story.clock(T0),
      Story.when(ListLogins.make({ credentials: ["a", "b"] })),
      Story.then(LoginsListed.make({ credentials: ["a", "b"] })),
      Story.when(ListLogins.make({ credentials: ["a", "b"] })),
      Story.then(),
      Story.when(ListLogins.make({ credentials: ["b"] })),
      Story.then(LoginsListed.make({ credentials: ["b"] })),
    ))

  test("a pool with no login refuses to place a request", () =>
    run(
      Story.clock(T0),
      Story.when(PlaceRequest.make({ sessionID: "s1", kind: "primary" })),
      Story.rejected(new NoAccount({ sessionID: "s1", kind: "primary" })),
    ))
})

describe("a request is placed", () => {
  test("a held account is skipped by a new placement", () => {
    const refusal = reading({ refusal: { kind: "rate-limit", until: T0 + 30_000 } })
    return run(
      accounts("a", "b"),
      Story.clock(T0),
      Story.when(TakeReading.make({ credentialID: "a", reading: refusal })),
      Story.then(
        ReadingTaken.make({ credentialID: "a", reading: refusal, hold: { kind: "rate-limit", until: T0 + 30_000, at: T0 } }),
      ),
      ...placed("s1", "b", T0),
    )
  })

  test("a run keeps its account for every request, even when another ranks better", () =>
    run(
      accounts("a", "b"),
      Story.clock(T0),
      ...placed("s1", "a", T0),
      ...stepped("s1", "a", 5, T0),
      ...placed("s2", "b", T0),
      ...stepped("s2", "b", 0.1, T0),
      // A new run goes to b now: a carries s1's $5 and s1 itself.
      ...placed("s9", "b", T0),
      ...placed("s1", "a", T0),
      ...placed("s1", "a", T0, "title"),
    ))

  test("a run leaves its account only when the account is held, and keeps its new pin after", () => {
    const refusal = reading({ refusal: { kind: "usage-limit", until: T0 + 20 * MINUTE } })
    return run(
      accounts("a", "b"),
      Story.clock(T0),
      ...placed("s1", "a", T0),
      Story.when(TakeReading.make({ credentialID: "a", reading: refusal })),
      Story.then(
        ReadingTaken.make({ credentialID: "a", reading: refusal, hold: { kind: "usage-limit", until: T0 + 20 * MINUTE, at: T0 } }),
      ),
      ...placed("s1", "b", T0),
      Story.clock(T0 + 21 * MINUTE),
      ...placed("s1", "b", T0 + 21 * MINUTE),
      // a's hold has ended: a new run goes there, where no other run is.
      ...placed("s2", "a", T0 + 21 * MINUTE),
    )
  })

  test("a run that ended is placed afresh, near its cache while it lives", () =>
    run(
      accounts("a", "b"),
      Story.clock(T0),
      ...placed("s1", "a", T0),
      ...placed("s2", "b", T0),
      ...placed("s3", "a", T0),
      ...released("s1"),
      // a carries s3, b carries s2: a tie, and s1's cache is on a.
      ...placed("s1", "a", T0),
      ...stepped("s3", "a", 1, T0),
      // a now scores 2 (s3 live, one mean session of load), b 1: within one session, s1 stays by its cache.
      ...placed("s1", "a", T0),
      ...released("s1"),
      Story.clock(T0 + CACHE_LIFE_MS),
      // Its cache gone, s1 goes to the lower score.
      ...placed("s1", "b", T0 + CACHE_LIFE_MS),
    ))

  test("a pin of a run that stopped without going idle expires", () =>
    run(
      accounts("a", "b"),
      Story.clock(T0),
      ...placed("s1", "a", T0),
      ...read("b", reading({ windows: [{ name: "7d", utilization: 0.2, resetAt: T0 + 5 * HOUR }] })),
      ...read("a", reading({ windows: [{ name: "7d", utilization: 0.2, resetAt: T0 + 50 * HOUR }] })),
      Story.clock(T0 + PIN_IDLE_MS),
      ...placed("s1", "b", T0 + PIN_IDLE_MS),
    ))

  test("the soonest weekly reset wins between fresh accounts", () =>
    run(
      accounts("a", "b"),
      Story.clock(T0),
      ...read("a", reading({ windows: [{ name: "7d", utilization: 0.3, resetAt: T0 + 100 * HOUR }] })),
      ...read("b", reading({ windows: [{ name: "7d", utilization: 0.6, resetAt: T0 + 10 * HOUR }] })),
      ...placed("s1", "b", T0),
    ))

  test("a window that has reset counts as empty", () =>
    run(
      accounts("a", "b"),
      Story.clock(T0),
      ...read("a", reading({ windows: [{ name: "5h", utilization: 0.95, resetAt: T0 + HOUR }] })),
      // a is at its share of the 5-hour window: it goes after b.
      ...placed("s1", "b", T0),
      Story.clock(T0 + HOUR),
      // The window has reset: a has room, and no run, so it goes before b.
      ...placed("s2", "a", T0 + HOUR),
    ))
})

describe("an account is held", () => {
  test("by a plan-limit refusal until its window resets, then freed", () => {
    const reset = T0 + 3 * HOUR
    const refusal = reading({
      status: "rejected",
      windows: [{ name: "5h", utilization: 1, resetAt: reset }],
      refusal: { kind: "usage-limit", until: reset },
    })
    return run(
      accounts("a", "b"),
      Story.clock(T0),
      Story.when(TakeReading.make({ credentialID: "a", reading: refusal })),
      Story.then(ReadingTaken.make({ credentialID: "a", reading: refusal, hold: { kind: "usage-limit", until: reset, at: T0 } })),
      Story.clock(reset - 1),
      ...placed("s1", "b", reset - 1),
      Story.clock(reset),
      ...placed("s2", "a", reset),
    )
  })

  test("by a window read as exhausted until it resets, with no refusal", () => {
    const exhausted = reading({ windows: [{ name: "7d", utilization: 1, resetAt: T0 + 40 * HOUR }] })
    return run(
      accounts("a", "b"),
      Story.clock(T0),
      Story.when(TakeReading.make({ credentialID: "a", reading: exhausted })),
      Story.then(
        ReadingTaken.make({ credentialID: "a", reading: exhausted, hold: { kind: "usage-limit", until: T0 + 40 * HOUR, at: T0 } }),
      ),
      ...placed("s1", "b", T0),
    )
  })

  test("only longer: a shorter refusal never frees an account a longer one holds", () => {
    const long = reading({ refusal: { kind: "usage-limit", until: T0 + 5 * HOUR } })
    const short = reading({ refusal: { kind: "rate-limit", until: T0 + 20_000 } })
    return run(
      accounts("a", "b"),
      Story.clock(T0),
      Story.when(TakeReading.make({ credentialID: "a", reading: long })),
      Story.then(ReadingTaken.make({ credentialID: "a", reading: long, hold: { kind: "usage-limit", until: T0 + 5 * HOUR, at: T0 } })),
      ...read("a", short),
    )
  })

  test("by a refused response without a reading, for the default time, unless it already is", () =>
    run(
      accounts("a", "b"),
      Story.clock(T0),
      Story.when(RefuseRequest.make({ credentialID: "a", status: 429 })),
      Story.then(RequestRefused.make({ credentialID: "a", hold: { kind: "rate-limit", until: T0 + DEFAULT_HOLD_MS, at: T0 } })),
      Story.when(RefuseRequest.make({ credentialID: "b", status: 401 })),
      Story.then(RequestRefused.make({ credentialID: "b", hold: { kind: "unauthorized", until: T0 + DEFAULT_HOLD_MS, at: T0 } })),
      Story.when(RefuseRequest.make({ credentialID: "a", status: 429 })),
      Story.then(),
    ))

  test("after a refresh with an unclear outcome, and never tried again until signed in", () => {
    // The auth plugin blocks a refresh token whose refresh failed unclearly
    // and reports a sign-in refusal: the pool must not send that login again.
    const signin = reading({ refusal: { kind: "signin", until: T0 + 30 * MINUTE } })
    return run(
      accounts("a", "b"),
      Story.clock(T0),
      ...placed("s1", "a", T0),
      Story.when(TakeReading.make({ credentialID: "a", reading: signin })),
      Story.then(ReadingTaken.make({ credentialID: "a", reading: signin, hold: { kind: "signin", until: T0 + 30 * MINUTE, at: T0 } })),
      ...placed("s1", "b", T0),
      ...placed("s2", "b", T0),
      ...placed("s3", "b", T0),
      ...placed("s4", "b", T0),
      Story.clock(T0 + 29 * MINUTE),
      ...placed("s5", "b", T0 + 29 * MINUTE),
    )
  })
})

describe("a step is recorded", () => {
  test("on the account the run's primary request went out on; a step that is not a price, or of no run here, is not", () =>
    run(
      accounts("a", "b"),
      Story.clock(T0),
      Story.when(RecordStep.make({ sessionID: "s1", cost: 1 })),
      Story.then(),
      ...placed("s1", "a", T0),
      ...stepped("s1", "a", 0.25, T0),
      Story.when(RecordStep.make({ sessionID: "s1", cost: Number.NaN })),
      Story.then(),
      Story.when(RecordStep.make({ sessionID: "s1", cost: -1 })),
      Story.then(),
    ))
})

describe("a run ends", () => {
  test("only when the session has a run here", () =>
    run(accounts("a"), Story.clock(T0), Story.when(ReleaseRun.make({ sessionID: "s1" })), Story.then()))
})

describe("the ledger is pruned", () => {
  test("of steps out of the window, past holds, idle pins and dead caches", () => {
    const refusal = reading({ refusal: { kind: "rate-limit", until: T0 + 1000 } })
    return run(
      accounts("a"),
      Story.clock(T0),
      ...placed("s1", "a", T0),
      ...stepped("s1", "a", 1, T0),
      Story.when(TakeReading.make({ credentialID: "a", reading: refusal })),
      Story.then(ReadingTaken.make({ credentialID: "a", reading: refusal, hold: { kind: "rate-limit", until: T0 + 1000, at: T0 } })),
      Story.when(PruneLedger.make({})),
      Story.then(),
      Story.clock(T0 + WINDOW_MS),
      Story.when(PruneLedger.make({})),
      Story.then(
        LedgerPruned.make({ steps: [{ at: T0, sessionID: "s1", credentialID: "a", cost: 1 }], holds: ["a"], runs: ["s1"], caches: ["s1"] }),
      ),
      Story.when(PruneLedger.make({})),
      Story.then(),
    )
  })
})
