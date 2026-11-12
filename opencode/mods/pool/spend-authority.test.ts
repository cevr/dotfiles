// The fleet's spend authority as a small state machine, checked exhaustively
// over small bounds: hosts × links up or down × answers lost × restarts ×
// time × clock skew × the owner's yes or none. Each host runs the claim of
// model.ts (`sendClaim`) step by step on the real lease table (lease.ts):
// read the account, begin, ask every peer, the `verdict`, hold, read again
// right before the send, send, finish and release. Every interleaving of
// those steps with the environment's is explored.
//
// Each host has its own clock, off the real time by a fixed amount (up to
// twice SETTLE_MS either way): every lease call, ask, release and sent claim
// a host makes carries its clock; the provider's lag runs on real time.
//
// The provider is adversarial: each host picked another grant under another
// request id, so nothing is deduped, and a reading may lag a claim by up to
// SETTLE_MS (a lagging reading shows the account as if the claims of the last
// SETTLE_MS were not made). A claim is useful only while no claim was spent.
//
// The property: at most one grant is spent per decision, unless the owner's
// yes sent a claim past a peer that could not be reached (the owner is the
// authority in a partition). The mutants below (the old fallback that passes
// over a silent peer unasked, no read right before the send, a restart that
// forgets the claims it sent, answers that ask the lease table alone, and
// round 5's comparison of the asker's reading time with the claimer's
// claim time, two clocks) each
// break it, so the model reaches the cases that matter. A host's sends are
// kept as its Resets store keeps them (resets.ts `claimOut`): a restart
// keeps them; the lease table goes with the process, and starts quiet.
import { describe, expect, test } from "bun:test"
import * as Lease from "./lease.ts"

const NAMES = ["mac", "workbox", "spare"]
const T0 = Date.parse("2026-11-11T12:00:00Z")
const STEPS = [1_000, Lease.LEASE_MS, Lease.SETTLE_MS]

type Answer = Lease.LeaseAnswer | "pending" | "silent"

interface Proc {
  readonly pc: "idle" | "asking" | "held" | "done"
  readonly runs: number
  readonly id?: string
  readonly readAt?: number
  readonly requestedAt?: number
  readonly answers?: ReadonlyArray<Answer>
  readonly passedOver?: boolean
}

interface World {
  readonly now: number
  readonly tables: ReadonlyArray<Lease.LeaseTable>
  /** Links down, as `i-j` with i < j: nothing passes either way. */
  readonly down: ReadonlyArray<string>
  readonly procs: ReadonlyArray<Proc>
  readonly releases: ReadonlyArray<{ readonly to: number; readonly message: Lease.LeaseRelease }>
  /** The grants spent: by whom, when, and whether past an unreachable peer on the owner's yes. */
  readonly spends: ReadonlyArray<{ readonly host: number; readonly at: number; readonly partitioned: boolean }>
  /** The claims each host sent, as its Resets store keeps them across a restart (`claimOut`). */
  readonly sent: ReadonlyArray<ReadonlyArray<number>>
  readonly budget: { readonly advance: number; readonly cut: number; readonly restart: number; readonly lost: number; readonly outside: number }
}

interface Bounds {
  readonly hosts: number
  readonly yes: ReadonlyArray<boolean>
  readonly runs: number
  readonly advance: number
  readonly cut: number
  readonly restart: number
  readonly lost: number
  /** Whether a reading may lag a claim by up to SETTLE_MS. */
  readonly lag: boolean
  /** Claims made outside the fleet (the owner in Claude's app): only where readings do not lag, since no host could see one then. */
  readonly outside: number
  /** Each host's clock, ahead of the real time by this much (behind when negative). */
  readonly clocks?: ReadonlyArray<number>
}

/** A change the model may break, to show the property depends on it. */
interface Mutant {
  /** A claim no one asked for passes over a silent peer (the fallback of round 4). */
  readonly passOver?: boolean
  /** No reading right before the send. */
  readonly noRejudge?: boolean
  /** A restarted host lends at once. */
  readonly noQuiet?: boolean
  /** A host answers a peer from its lease table alone, not its Resets store (`claimOut`). */
  readonly storeSilent?: boolean
  /** A restarted host forgets the claims it sent (no `claimOut`). */
  readonly forgets?: boolean
  /** Round 5: a peer's claim is seen at the claimer's `claimedAt`, and an ask judged by the asker's `readAt`: two clocks compared. */
  readonly crossClock?: boolean
}

/** `host`'s clock at the world's real time. */
const clock = (world: World, bounds: Bounds, host: number) => world.now + (bounds.clocks?.[host] ?? 0)

const pair = (left: number, right: number) => (left < right ? `${left}-${right}` : `${right}-${left}`)

/** What a reading at `now` may say: claimable (no spend shows) or not, fresh, or, when readings lag, lagging by up to SETTLE_MS. */
const reads = (world: World, bounds: Bounds): ReadonlyArray<boolean> => {
  const fresh = world.spends.length === 0
  const lagging = world.spends.every((spend) => spend.at > world.now - Lease.SETTLE_MS)
  return bounds.lag ? [...new Set([fresh, lagging])] : [fresh]
}

const replace = <A>(items: ReadonlyArray<A>, at: number, item: A) => items.map((old, index) => (index === at ? item : old))

const askOf = (world: World, host: number): Lease.LeaseAsk => {
  const proc = world.procs[host]!
  return Lease.LeaseAsk.make({
    host: NAMES[host]!,
    id: proc.id!,
    provider: "claude",
    grants: [`g${host}`],
    readAt: proc.readAt!,
    requestedAt: proc.requestedAt!,
    holdMs: Lease.LEASE_MS,
  })
}

/** The host's run ends: its lease finished here, and released to each peer that granted it (with the claim's time when one was sent). */
const end = (world: World, host: number, pc: Proc["pc"], claimedAt?: number): World => {
  const proc = world.procs[host]!
  const releases = (proc.answers ?? []).flatMap((answer, peer) =>
    typeof answer === "object" && answer.granted
      ? [{ to: peer, message: Lease.LeaseRelease.make({ host: NAMES[host]!, id: proc.id!, provider: "claude", grants: [`g${host}`], ...(claimedAt === undefined ? {} : { claimedAt }) }) }]
      : [],
  )
  return {
    ...world,
    tables: replace(world.tables, host, Lease.finish(world.tables[host]!, proc.id!)),
    procs: replace(world.procs, host, { pc, runs: proc.runs }),
    releases: [...world.releases, ...releases],
  }
}

/** Every world one step from `world`. */
const next = (world: World, bounds: Bounds, mutant: Mutant): ReadonlyArray<World> => {
  const out: Array<World> = []
  for (let host = 0; host < bounds.hosts; host++) {
    const proc = world.procs[host]!
    const name = NAMES[host]!
    if (proc.pc === "idle" && proc.runs < bounds.runs) {
      for (const claimable of reads(world, bounds)) {
        if (!claimable) {
          out.push({ ...world, procs: replace(world.procs, host, { pc: "done", runs: proc.runs + 1 }) })
          continue
        }
        const id = `${name}:${proc.runs}`
        const local = clock(world, bounds, host)
        const ask = { id, provider: "claude" as const, grants: [`g${host}`], readAt: local, requestedAt: local, holdMs: Lease.LEASE_MS }
        const kept = mutant.forgets !== true && world.sent[host]!.some((at) => local < at + Lease.SETTLE_MS) ? "a claim out" : undefined
        const [why, table] = kept !== undefined ? [kept, world.tables[host]!] : Lease.begin(world.tables[host]!, name, ask, local)
        const tables = replace(world.tables, host, table)
        out.push(
          why !== undefined
            ? { ...world, tables, procs: replace(world.procs, host, { pc: "idle", runs: proc.runs + 1 }) }
            : {
                ...world,
                tables,
                procs: replace(world.procs, host, {
                  pc: "asking",
                  runs: proc.runs + 1,
                  id,
                  readAt: local,
                  requestedAt: local,
                  answers: Array.from({ length: bounds.hosts }, (_, peer): Answer => (peer === host ? "silent" : "pending")),
                }),
              },
        )
      }
    }
    if (proc.pc === "asking") {
      const answers = proc.answers!
      const pending = answers.flatMap((answer, peer) => (answer === "pending" ? [peer] : []))
      for (const peer of pending) {
        const answered = (answer: Answer, tables = world.tables, budget = world.budget): World => ({
          ...world,
          tables,
          budget,
          procs: replace(world.procs, host, { ...proc, answers: replace(answers, peer, answer) }),
        })
        if (world.down.includes(pair(host, peer))) {
          out.push(answered("silent"))
          continue
        }
        // The peer judges the ask on its own clock; round 5's mutant, by the asker's reading time.
        const judged = mutant.crossClock === true ? proc.readAt! : clock(world, bounds, peer)
        const claimOut = mutant.forgets !== true && mutant.storeSilent !== true && world.sent[peer]!.some((at) => judged < at + Lease.SETTLE_MS)
        const [answer, table] = claimOut ? ([{ granted: false, reason: "a claim out" }, world.tables[peer]!] as const) : Lease.answer(world.tables[peer]!, NAMES[peer]!, askOf(world, host), judged)
        const tables = replace(world.tables, peer, table)
        out.push(answered(answer, tables))
        // The peer answered, and the answer was lost on the way back.
        if (world.budget.lost > 0) out.push(answered("silent", tables, { ...world.budget, lost: world.budget.lost - 1 }))
      }
      if (pending.length === 0) {
        const peers = answers.flatMap((answer, peer) => (peer === host ? [] : [{ peer: NAMES[peer]!, answer: typeof answer === "object" ? answer : undefined }]))
        const verdict = Lease.verdict(peers, bounds.yes[host] === true || mutant.passOver === true)
        if (verdict._tag === "refused") out.push(end(world, host, "idle"))
        else if (verdict._tag === "unreachable") out.push(end(world, host, "done"))
        else {
          const [held, table] = Lease.hold(world.tables[host]!, proc.id!, clock(world, bounds, host))
          out.push(
            held
              ? { ...world, tables: replace(world.tables, host, table), procs: replace(world.procs, host, { ...proc, pc: "held", passedOver: verdict.passedOver.length > 0 }) }
              : end(world, host, "idle"),
          )
        }
      }
    }
    // The reading right before the send and the send are one step here: a claim made outside the fleet between them is a race no host can see.
    if (proc.pc === "held")
      for (const claimable of mutant.noRejudge === true ? [true] : reads(world, bounds)) {
        if (!claimable) out.push(end(world, host, "done"))
        else {
          const local = clock(world, bounds, host)
          const spent = {
            ...world,
            sent: replace(world.sent, host, [...world.sent[host]!, local]),
            spends: [...world.spends, { host, at: world.now, partitioned: proc.passedOver === true && bounds.yes[host] === true }],
          }
          out.push(end(spent, host, "done", local))
        }
      }
  }
  // A release on its way: taken in, or lost on a link down.
  world.releases.forEach((item, index) => {
    const releases = world.releases.filter((_, at) => at !== index)
    const from = NAMES.indexOf(item.message.host)
    out.push(
      world.down.includes(pair(from, item.to))
        ? { ...world, releases }
        : {
            ...world,
            releases,
            // Taken on the receiver's clock; round 5's mutant, at the claimer's `claimedAt`.
            tables: replace(world.tables, item.to, Lease.release(world.tables[item.to]!, item.message, mutant.crossClock === true ? (item.message.claimedAt ?? clock(world, bounds, item.to)) : clock(world, bounds, item.to))),
          },
    )
  })
  if (world.budget.outside > 0 && world.spends.length === 0)
    out.push({ ...world, spends: [{ host: -1, at: world.now, partitioned: false }], budget: { ...world.budget, outside: world.budget.outside - 1 } })
  if (world.budget.advance > 0)
    for (const step of STEPS) out.push({ ...world, now: world.now + step, budget: { ...world.budget, advance: world.budget.advance - 1 } })
  if (world.budget.cut > 0)
    for (let left = 0; left < bounds.hosts; left++)
      for (let right = left + 1; right < bounds.hosts; right++)
        if (!world.down.includes(pair(left, right))) out.push({ ...world, down: [...world.down, pair(left, right)], budget: { ...world.budget, cut: world.budget.cut - 1 } })
  if (world.budget.restart > 0)
    for (let host = 0; host < bounds.hosts; host++) {
      const proc = world.procs[host]!
      // The process goes: its table, its run (a claim not yet sent is never sent) and its releases on their way. Its store keeps the claim to go again.
      out.push({
        ...world,
        tables: replace(world.tables, host, mutant.noQuiet === true ? Lease.emptyTable : Lease.started(clock(world, bounds, host))),
        procs: replace(world.procs, host, { pc: proc.runs < bounds.runs ? "idle" : "done", runs: proc.runs }),
        releases: world.releases.filter((item) => item.message.host !== NAMES[host]),
        budget: { ...world.budget, restart: world.budget.restart - 1 },
      })
    }
  return out
}

/** The property, at one world: one grant spent at most, but for those the owner's yes sent past an unreachable peer. */
const safe = (world: World) => world.spends.length <= 1 + world.spends.filter((spend) => spend.partitioned).length

interface Explored {
  readonly states: number
  readonly counterexample?: World
  /** Whether some world spent exactly one grant: the model is not safe by never claiming. */
  readonly spendsOne: boolean
}

const explore = (bounds: Bounds, mutant: Mutant = {}): Explored => {
  const start: World = {
    now: T0,
    // Every host has run long past its start: not quiet.
    tables: Array.from({ length: bounds.hosts }, () => Lease.emptyTable),
    down: [],
    procs: Array.from({ length: bounds.hosts }, (): Proc => ({ pc: "idle", runs: 0 })),
    releases: [],
    spends: [],
    sent: Array.from({ length: bounds.hosts }, () => []),
    budget: { advance: bounds.advance, cut: bounds.cut, restart: bounds.restart, lost: bounds.lost, outside: bounds.outside },
  }
  const seen = new Set<string>()
  const stack: Array<World> = [start]
  let spendsOne = false
  while (stack.length > 0) {
    const world = stack.pop()!
    const key = JSON.stringify(world)
    if (seen.has(key)) continue
    seen.add(key)
    if (!safe(world)) return { states: seen.size, counterexample: world, spendsOne }
    if (world.spends.length === 1) spendsOne = true
    stack.push(...next(world, bounds, mutant))
  }
  return { states: seen.size, spendsOne }
}

/** Two hosts whose readings lag: each runs twice (a back-off, a restart), two steps of time, a cut, a restart, a lost answer. */
const TWO: Omit<Bounds, "yes"> = { hosts: 2, runs: 2, advance: 2, cut: 1, restart: 1, lost: 1, lag: true, outside: 0 }
/** Two hosts whose readings do not lag, and a claim made outside the fleet. */
const OUTSIDE: Omit<Bounds, "yes"> = { ...TWO, lag: false, outside: 1 }
const THREE: Omit<Bounds, "yes"> = { hosts: 3, runs: 1, advance: 1, cut: 1, restart: 0, lost: 0, lag: true, outside: 0 }
/** The second host's clock against the first's: SETTLE_MS (round 5's M1 needed that much) or twice it, ahead or behind. */
const SKEWS = [-2 * Lease.SETTLE_MS, -Lease.SETTLE_MS, Lease.SETTLE_MS, 2 * Lease.SETTLE_MS]
const YES2: ReadonlyArray<ReadonlyArray<boolean>> = [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
]

describe("the spend authority, every interleaving within small bounds", () => {
  test("two hosts, each with or without the owner's yes, over link cuts, lost answers, a restart and time: at most one grant spent but past a peer the owner's yes passed over", () => {
    for (const yes of YES2) {
      const found = explore({ ...TWO, yes })
      expect(found.counterexample, `yes ${yes}`).toBeUndefined()
      expect(found.spendsOne, `yes ${yes}`).toBe(true)
    }
  }, 60_000)

  test("two hosts whose readings do not lag, and the owner claiming in Claude's app meanwhile: no host spends a second grant unasked", () => {
    const found = explore({ ...OUTSIDE, yes: [false, false] })
    expect(found.counterexample).toBeUndefined()
    expect(found.spendsOne).toBe(true)
  }, 60_000)

  test("two hosts whose clocks are SETTLE_MS or twice it apart, either way, each with or without the owner's yes: the same", () => {
    for (const skew of SKEWS)
      for (const yes of YES2) {
        const found = explore({ ...TWO, yes, clocks: [0, skew] })
        expect(found.counterexample, `skew ${skew} yes ${yes}`).toBeUndefined()
        expect(found.spendsOne, `skew ${skew} yes ${yes}`).toBe(true)
      }
  }, 300_000)

  test("three hosts, none with a yes: one grant at most", () => {
    const found = explore({ ...THREE, yes: [false, false, false] })
    expect(found.counterexample).toBeUndefined()
    expect(found.spendsOne).toBe(true)
  }, 60_000)
})

describe("the model reaches what breaks it", () => {
  test("a claim no one asked for that passes over a silent peer (round 4's fallback) spends two grants", () => {
    const found = explore({ ...TWO, yes: [false, false] }, { passOver: true })
    expect(found.counterexample?.spends.length).toBe(2)
  })

  test("no reading right before the send: a claim made outside the fleet during the ask is followed by a second grant", () => {
    const found = explore({ ...OUTSIDE, yes: [false, false] }, { noRejudge: true })
    expect(found.counterexample?.spends.length).toBe(2)
  })

  test("a host that judges a peer's claim by the claimer's clock and an ask by the asker's (round 5, M1) spends two grants once the clocks are SETTLE_MS apart, and only then", () => {
    for (const skew of [Lease.SETTLE_MS, -Lease.SETTLE_MS]) expect(explore({ ...TWO, yes: [false, false], clocks: [0, skew] }, { crossClock: true }).counterexample?.spends.length, `skew ${skew}`).toBe(2)
    expect(explore({ ...TWO, yes: [false, false] }, { crossClock: true }).counterexample).toBeUndefined()
  }, 120_000)

  test("a restarted host that forgets the claim it sent spends two grants", () => {
    const found = explore({ ...TWO, yes: [false, false] }, { forgets: true })
    expect(found.counterexample?.spends.length).toBe(2)
  })

  test("a host that answers a peer from its lease table alone, not the claims its store keeps, spends two grants", () => {
    expect(explore({ ...TWO, yes: [false, false] }, { storeSilent: true }).counterexample?.spends.length).toBe(2)
  })

  test("without the quiet after a restart, still one grant: a lease the restarted lender forgot, its borrower holds and refuses others with; the quiet is a second guard", () => {
    expect(explore({ ...TWO, yes: [false, false] }, { noQuiet: true }).counterexample).toBeUndefined()
  }, 60_000)
})
