// The AccountPool aggregate's stories: a request is placed on the run's pin,
// the account its cache is on, or the best account; a reading or a refusal
// holds an account, a step counts on its account, a run ends, a restored pool
// keeps each cache where it was, and the ledger forgets what has expired.
import { describe, test } from "bun:test"
import { Effect } from "effect"
import * as Story from "@dotfiles/decider/story"
import {
  AccountPool,
  LedgerPruned,
  ListLogins,
  LoginsListed,
  NoAccount,
  PlaceRequest,
  PruneLedger,
  ReadingTaken,
  RecordStep,
  RefuseRequest,
  ReleaseRun,
  RequestPlaced,
  RequestRefused,
  restored,
  RunReleased,
  StepRecorded,
  TakeReading,
  type Event,
  type LedgerState,
} from "./account-pool.ts"
import { CACHE_LIFE_MS, DEFAULT_HOLD_MS, DEFAULT_RULES, PIN_IDLE_MS, WINDOW_MS, type RequestKind } from "./accounts.ts"
import type { QuotaReading } from "./quota.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const T0 = 1_800_000_000_000

const story = Story.make(AccountPool(DEFAULT_RULES))
const run = (...steps: Parameters<typeof story>) => Effect.runPromise(story(...steps))
/** A pool whose caches live an hour, as Claude's do when `bun run daily` asks for it. */
const hourStory = Story.make(AccountPool({ cacheLifeMs: HOUR }))

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
      // a now scores 2 (s3 live, one mean session of load), b 1: s1 stays by its cache.
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

describe("a session's cache keeps its account", () => {
  /** A priced step already taken: the session's cache is on `credentialID` from `at`, with no run. */
  const took = (sessionID: string, credentialID: string, cost: number, at: number): Event =>
    StepRecorded.make({ step: { at, sessionID, credentialID, cost } })

  test("while it lives, a new run stays on the cache's account, however much better another scores", () =>
    run(
      accounts("a", "b"),
      Story.given(
        took("s1", "a", 5, T0),
        RequestPlaced.make({ sessionID: "s2", kind: "primary", credentialID: "a", at: T0 }),
        RequestPlaced.make({ sessionID: "s3", kind: "primary", credentialID: "a", at: T0 }),
        took("s4", "b", 1, T0),
      ),
      Story.clock(T0 + MINUTE),
      // A unit is $3: a scores 5/3 + 2 live, b 1/3 + 1 live, more than a session apart; s1's cache is on a.
      ...placed("s1", "a", T0 + MINUTE),
    ))

  test("a fork with no cache of its own goes where its source's cache lives, then by load once that is gone", () =>
    run(
      accounts("a", "b"),
      Story.given(took("s1", "a", 5, T0), took("s2", "b", 1, T0)),
      Story.clock(T0 + MINUTE),
      // b scores better, but the fork reads s1's cache, which is on a.
      Story.when(PlaceRequest.make({ sessionID: "fork", kind: "primary", cacheOf: "s1" })),
      Story.then(RequestPlaced.make({ sessionID: "fork", kind: "primary", credentialID: "a", at: T0 + MINUTE })),
      ...released("fork"),
      // Its own cache, now on a, comes before the source's.
      Story.when(PlaceRequest.make({ sessionID: "fork", kind: "primary", cacheOf: "s2" })),
      Story.then(RequestPlaced.make({ sessionID: "fork", kind: "primary", credentialID: "a", at: T0 + MINUTE })),
      // A fork of a session whose cache is gone is placed by load.
      Story.clock(T0 + MINUTE + CACHE_LIFE_MS),
      Story.when(PlaceRequest.make({ sessionID: "fork2", kind: "primary", cacheOf: "s1" })),
      Story.then(RequestPlaced.make({ sessionID: "fork2", kind: "primary", credentialID: "b", at: T0 + MINUTE + CACHE_LIFE_MS })),
    ))

  test("for the pool's cache life, then the run is placed by load", () =>
    Effect.runPromise(
      hourStory(
        accounts("a", "b"),
        Story.given(took("s1", "a", 5, T0), took("s2", "b", 1, T0)),
        // Half an hour on, past Anthropic's default 5 minutes: s1's cache still lives on a, and b scores better.
        Story.clock(T0 + 30 * MINUTE),
        ...placed("s1", "a", T0 + 30 * MINUTE),
        ...released("s1"),
        // An hour after its last request the cache is gone: s1 goes where the load is lower.
        Story.clock(T0 + 90 * MINUTE),
        ...placed("s1", "b", T0 + 90 * MINUTE),
      ),
    ))

  test("it leaves an account that is held", () => {
    const refusal = reading({ refusal: { kind: "rate-limit", until: T0 + HOUR } })
    return run(
      accounts("a", "b"),
      Story.given(took("s1", "a", 1, T0)),
      Story.clock(T0 + MINUTE),
      Story.when(TakeReading.make({ credentialID: "a", reading: refusal })),
      Story.then(ReadingTaken.make({ credentialID: "a", reading: refusal, hold: { kind: "rate-limit", until: T0 + HOUR, at: T0 + MINUTE } })),
      ...placed("s1", "b", T0 + MINUTE),
    )
  })

  test("it leaves an account with no room while another has room, and stays when none has", () => {
    const full = reading({ windows: [{ name: "5h", utilization: 0.95, resetAt: T0 + HOUR }] })
    return run(
      accounts("a", "b", "c"),
      Story.given(took("s1", "a", 1, T0), took("s2", "a", 1, T0)),
      Story.clock(T0 + MINUTE),
      ...read("a", full),
      ...read("b", full),
      ...read("c", full),
      // Every account is at its share: s1 stays where its cache is.
      ...placed("s1", "a", T0 + MINUTE),
      ...released("s1"),
      ...read("c", reading()),
      // c has room again: s2 leaves a for it.
      ...placed("s2", "c", T0 + MINUTE),
    )
  })
})

describe("a restored pool", () => {
  const ledger: LedgerState = {
    holds: {},
    readings: {},
    steps: [
      { at: T0, sessionID: "s1", credentialID: "a", cost: 5 },
      { at: T0, sessionID: "s2", credentialID: "b", cost: 1 },
    ],
    recent: { s1: { credentialID: "a", at: T0 }, s2: { credentialID: "b", at: T0 } },
  }
  const restoredStory = Story.make({ ...AccountPool(DEFAULT_RULES), initial: restored(ledger) })

  test("keeps a session on the account its cache is on while it lives", () =>
    Effect.runPromise(
      restoredStory(
        accounts("a", "b"),
        Story.clock(T0 + MINUTE),
        // b scores better (1/3 + s2's cache against 5/3), but s1's cache is on a.
        ...placed("s1", "a", T0 + MINUTE),
      ),
    ))

  test("drops a cache that no longer lives at its first prune, and places that session by load", () =>
    Effect.runPromise(
      restoredStory(
        accounts("a", "b"),
        Story.clock(T0 + CACHE_LIFE_MS),
        Story.when(PruneLedger.make({})),
        Story.then(LedgerPruned.make({ steps: [], holds: [], runs: [], caches: ["s1", "s2"] })),
        ...placed("s1", "b", T0 + CACHE_LIFE_MS),
      ),
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
