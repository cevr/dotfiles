// The kept counter (`counter`) answers as a recount of every request from
// scratch (`recount`, the reference) does: the same rows, tally, report and
// file, to the last digit, over generated runs of requests, readings,
// expiries, peer reports, resets and merges with the file.
import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import {
  counter,
  emptyState,
  limitsLine,
  merge,
  observe,
  recount,
  reportOf,
  resetInside,
  tally,
  takePeer,
  USE_KEPT_MS,
  type LimitsState,
  type Use,
} from "./limits.ts"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const T0 = Date.UTC(2026, 10, 1)
const ACCOUNTS = ["a", "b", "c"]
const MODELS = ["claude-opus-5-5", "anthropic/claude-fable-5-2", "claude-sonnet-5-5", "gpt-6.1-sol-ultrafast", "openai/gpt-6-luna", "mystery-1"]
/** Each window's length; a month's outlives the requests kept, so an expiry takes requests its open rows counted. */
const LENGTHS = { "5h": 5 * HOUR, "7d": 7 * DAY, "30d": 30 * DAY } satisfies Readonly<Record<string, number>>
/** How far ahead a period's reset can be read, in steps of this. */
const AHEAD = { "5h": HOUR, "7d": DAY, "30d": DAY } satisfies Readonly<Record<string, number>>

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** A seeded generator (mulberry32): each run is the same run again. */
const random = (seed: number) => {
  let s = seed >>> 0
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (n: number) => Math.floor(next() * n)
  return { int, pick: <A>(items: ReadonlyArray<A>) => items[int(items.length)]! }
}

/** What a host writes to its file, given its counted state. */
const fileOf = (state: LimitsState, at: number) => {
  const answer = tally(state, at)
  return json({ version: 1, line: Option.getOrElse(Option.fromUndefinedOr(limitsLine(answer)), () => "none"), tally: answer, state })
}

/** One generated run: the counter, the reference's requests, the host's state, its file and the time. */
const run = (seed: number) => {
  const r = random(seed)
  const kept = counter()
  const reference = new Map<string, Use>()
  const host = { now: T0 + 9 * DAY, state: emptyState(T0), file: emptyState(T0) }

  /** A reset the window's periods can have: a few, now's or the period's before, so readings land on the same rows again. */
  const resetOf = (window: keyof typeof LENGTHS) => Math.floor(host.now / HOUR) * HOUR + (1 + r.int(3)) * AHEAD[window] - r.int(2) * LENGTHS[window]

  /** The counter's answer on `held` checked against the reference's: the rows, the file and the report. */
  const check = (held: LimitsState, step: string) => {
    const mine = kept.recount(held, host.now)
    const theirs = recount(held, [...reference.values()], host.now)
    expect(json(mine), `seed ${seed}, ${step}: rows`).toBe(json(theirs))
    expect(fileOf(mine, host.now), `seed ${seed}, ${step}: file`).toBe(fileOf(theirs, host.now))
    expect(json(reportOf(mine, host.now)), `seed ${seed}, ${step}: report`).toBe(json(reportOf(theirs, host.now)))
    return mine
  }

  const request = () => {
    const id = `m-${r.int(400)}`
    const use: Use = {
      at: host.now - r.int(9 * DAY),
      pool: "anthropic",
      credentialID: r.pick(ACCOUNTS),
      model: r.pick(MODELS),
      tokens: { input: r.int(5000), output: r.int(3000), cacheRead: r.int(90_000), cacheWrite: r.int(7000) },
    }
    kept.add(id, use)
    if (!reference.has(id)) reference.set(id, use)
  }

  const reading = (at: number) => {
    const utilization = r.int(100) / 100
    return {
      at,
      windows: [
        { name: "5h", utilization, resetAt: resetOf("5h") },
        { name: "7d", utilization: utilization / 2, resetAt: resetOf("7d") },
        { name: "7d:Fable", utilization, resetAt: resetOf("7d"), weeklyUsed: utilization / 4 },
        { name: "30d", utilization: utilization / 3, resetAt: resetOf("30d") },
      ],
    }
  }

  /** A flush: requests past keep go, and the file holds the counted state. */
  const flush = (step: number) => {
    const through = host.now - USE_KEPT_MS
    kept.expire(through)
    for (const [id, use] of reference) if (use.at <= through) reference.delete(id)
    host.state = check(merge(host.file, host.state), `flush ${step}`)
    host.file = host.state
  }

  /** A peer's report of its own rows on one account. */
  const peer = () => {
    const theirs = observe(emptyState(T0), "anthropic", r.pick(ACCOUNTS), { at: host.now, windows: [{ name: "5h", utilization: 0.3, resetAt: resetOf("5h") }] })
    host.state = takePeer(host.state, r.pick(["workbox", "laptop"]), reportOf(kept.recount(theirs, host.now), host.now))
  }

  const ops: ReadonlyArray<(step: number) => void> = [
    request,
    request,
    request,
    request,
    () => void (host.state = observe(host.state, "anthropic", r.pick(ACCOUNTS), reading(host.now - r.int(2 * HOUR)))),
    () => void (host.now += r.int(3 * HOUR)),
    () => void (host.now += 2 * DAY),
    flush,
    peer,
    () => void (host.state = resetInside(host.state, "anthropic", r.pick(ACCOUNTS), host.now - r.int(DAY))),
    // A forecast counts the file and this state as one.
    (step) => void check(merge(host.file, host.state), `forecast ${step}`),
  ]
  for (let step = 0; step < 80; step++) {
    r.pick(ops)(step)
    // A tally counts this state.
    check(host.state, `step ${step}`)
  }
}

describe("the kept counter", () => {
  test("answers as the recount from scratch over generated runs", () => {
    for (let seed = 1; seed <= 150; seed++) run(seed)
  })
})
