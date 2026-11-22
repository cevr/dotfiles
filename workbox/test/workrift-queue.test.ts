// A model, on a manual clock, of how workrift admits creates (readers: a copy of the base) and moves of the base
// (writers: an advance's fast-forward and install, a refresh, a repair) to the base, and of what each writes inside
// the tree a copy reads. Two protocols:
//
// - "flock" (f5d1e180, on main): a turnstile and the base's lock taken with `flock -n`, then `flock -w 60` in a loop.
//   Linux flock keeps no arrival order: on a release every blocked waiter is woken and whichever runs first wins, and
//   a waiter whose 60 s ran out queues again at the back. Holder records live in the base's .git (created when a lock
//   is taken, removed when it is given back), creates fetch into the base outside any lock, and an advance warms the
//   base with only its own lock held.
// - "tickets" (this unit): a ticket per request, numbered in arrival order; a writer enters once every earlier ticket
//   has ended, a reader once every earlier writer has; a killed process's ticket ends when it dies (the kernel drops
//   its flock). Bookkeeping lives outside the base; every write of the base (fetch, fast-forward, install, hooks,
//   warm) is a writer's.
//
// Policies for the base's warm under tickets: "B" (an advance only moves the base; refresh warms) and "A" (an advance
// warms too, under the exclusive lock). The schedule of 2026-11-22 00:00Z on the workbox (11 creates waiting, master
// moving every ten minutes, 96-239 s clones, a 628 s warm) shows the wait each gives.
import { describe, expect, test } from "bun:test"

type Kind = "r" | "w"
type Protocol = "flock" | "tickets"
type Policy = "A" | "B"

interface Spec {
  readonly kind: Kind
  readonly arrive: number
  /** How long it holds once in. */
  readonly hold: number
  /** It dies (kill -9) at this time, waiting or holding. */
  readonly killAt?: number
  /**
   * A background writer (the advance) that defers to copies: it takes its place in line only once the line is empty,
   * or after this many seconds, whichever comes first.
   */
  readonly politeFor?: number
  readonly label: string
}

interface Ticket {
  readonly id: number
  readonly spec: Spec
  /** Its place in line: the time it took its ticket (a tie broken by its index), Infinity before. */
  number: number
  lineAt?: number
  state: "waiting" | "holding" | "done" | "dead"
  enteredAt?: number
  endedAt?: number
}

interface Run {
  readonly tickets: ReadonlyArray<Ticket>
  /** Times something other than a writer holding the base exclusively wrote inside the base, while a copy ran. */
  readonly hazards: ReadonlyArray<{ readonly at: number; readonly what: string }>
  readonly violations: ReadonlyArray<string>
}

/** A deterministic random stream. */
const random = (seed: number) => {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

/**
 * Runs `specs` under `protocol` on a manual clock (seconds). `flockPoll`: under flock, the order in which woken
 * waiters run is the random stream's; a waiter whose `flock -w 60` ran out re-queues.
 */
const simulate = (protocol: Protocol, specs: ReadonlyArray<Spec>, seed = 1): Run => {
  const next = random(seed)
  const order = specs.map((spec, id) => ({ spec, id })).sort((a, b) => a.spec.arrive - b.spec.arrive || a.id - b.id)
  const tickets: Array<Ticket> = order.map(({ spec }, id) =>
    spec.politeFor === undefined
      ? { id, spec, number: spec.arrive + id * 1e-6, lineAt: spec.arrive, state: "waiting" }
      : { id, spec, number: Infinity, state: "waiting" },
  )
  const hazards: Array<{ at: number; what: string }> = []
  const violations: Array<string> = []
  const arrived = (t: Ticket, now: number) => t.lineAt !== undefined && t.lineAt <= now
  const live = (t: Ticket, now: number) => arrived(t, now) && (t.state === "waiting" || t.state === "holding")
  const copying = (now: number, except?: Ticket) =>
    tickets.some((t) => t !== except && t.spec.kind === "r" && t.state === "holding" && (t.enteredAt ?? 0) < now)
  let now = 0
  let moving = false
  for (let step = 0; step < 100_000; step++) {
    // A polite writer takes its ticket once the line is empty or its patience is over.
    for (const t of tickets.filter((each) => each.lineAt === undefined && each.spec.arrive <= now && each.state === "waiting")) {
      if ((t.spec.killAt ?? Infinity) <= now) {
        t.state = "dead"
        t.endedAt = now
        continue
      }
      const empty = !tickets.some((o) => live(o, now))
      if (empty || now >= t.spec.arrive + (t.spec.politeFor ?? 0)) {
        t.lineAt = now
        t.number = now + t.id * 1e-6
      }
    }
    // Admit.
    const waiting = tickets.filter((t) => arrived(t, now) && t.state === "waiting")
    const holding = tickets.filter((t) => t.state === "holding")
    let requeued = false
    if (protocol === "tickets") {
      for (const t of [...waiting].sort((a, b) => a.number - b.number)) {
        const earlier = tickets.filter((o) => o.number < t.number && live(o, now))
        const blocked = t.spec.kind === "w" ? earlier.length > 0 : earlier.some((o) => o.spec.kind === "w")
        if (blocked) continue
        if (t.spec.kind === "r" && moving) {
          // The moving marker a killed move left: the create gives its place back, a repair (a writer) goes in line,
          // and the create comes again behind it.
          t.state = "done"
          t.endedAt = now
          for (const spec of [
            { kind: "w", arrive: now, hold: 5, label: `repair for ${t.spec.label}` },
            { kind: "r", arrive: now, hold: t.spec.hold, label: `${t.spec.label} again` },
          ] satisfies ReadonlyArray<Spec>) {
            const id = tickets.length
            tickets.push({ id, spec, number: now + id * 1e-6, lineAt: now, state: "waiting" })
          }
          requeued = true
          continue
        }
        t.state = "holding"
        t.enteredAt = now
      }
    } else {
      // Whoever the scheduler runs first among the woken waiters takes the lock, if it can.
      const shuffled = waiting.map((t) => ({ t, key: next() })).sort((a, b) => a.key - b.key).map((each) => each.t)
      for (const t of shuffled) {
        const writerIn = holding.some((o) => o.spec.kind === "w") || tickets.some((o) => o.state === "holding" && o.spec.kind === "w")
        const anyIn = tickets.some((o) => o.state === "holding")
        if (t.spec.kind === "w" ? anyIn : writerIn) continue
        t.state = "holding"
        t.enteredAt = now
        // The holder record, created in the base's .git while copies may read it.
        if (copying(now, t)) hazards.push({ at: now, what: `${t.spec.label}'s holder record created` })
      }
    }
    // A writer in the flock protocol that is an advance's warm writes the base all along with copies beside it
    // (modelled as one write at its end); under tickets a writer is alone.
    const events = [
      ...tickets.filter((t) => t.state === "holding").map((t) => Math.min(t.enteredAt! + t.spec.hold, t.spec.killAt ?? Infinity)),
      ...tickets.filter((t) => t.state === "waiting" && t.spec.arrive > now).map((t) => t.spec.arrive),
      ...tickets.filter((t) => t.state === "waiting" && t.lineAt === undefined && t.spec.politeFor !== undefined).map((t) => t.spec.arrive + t.spec.politeFor!),
      ...tickets.filter((t) => t.state === "waiting" && t.lineAt === undefined && t.spec.killAt !== undefined).map((t) => t.spec.killAt!),
      ...tickets.filter((t) => t.state === "waiting" && arrived(t, now) && t.spec.killAt !== undefined).map((t) => t.spec.killAt!),
    ].filter((time) => time > now)
    const due = tickets.filter((t) => t.state === "holding" && Math.min(t.enteredAt! + t.spec.hold, t.spec.killAt ?? Infinity) <= now)
    const dying = tickets.filter((t) => t.state === "waiting" && arrived(t, now) && (t.spec.killAt ?? Infinity) <= now)
    if (due.length === 0 && dying.length === 0) {
      if (requeued) continue
      if (events.length === 0) break
      now = Math.min(...events)
      continue
    }
    for (const t of due) {
      const killed = (t.spec.killAt ?? Infinity) <= t.enteredAt! + t.spec.hold
      t.state = killed ? "dead" : "done"
      t.endedAt = now
      // A writer killed while it held leaves the base moving; one that ends (a repair, a move) leaves it whole.
      if (t.spec.kind === "w") moving = killed
      if (protocol === "flock" && copying(now, t)) hazards.push({ at: now, what: `${t.spec.label}'s holder record removed` })
      if (protocol === "flock" && t.spec.kind === "w" && t.spec.label.includes("warm") && copying(now, t))
        hazards.push({ at: now, what: `${t.spec.label} wrote the base beside a copy` })
    }
    for (const t of dying) {
      t.state = "dead"
      t.endedAt = now
    }
  }
  // Mutual exclusion: a writer never holds beside anyone.
  for (const w of tickets.filter((t) => t.spec.kind === "w" && t.enteredAt !== undefined))
    for (const o of tickets.filter((t) => t !== w && t.enteredAt !== undefined))
      if ((o.enteredAt ?? 0) < (w.endedAt ?? Infinity) && (w.enteredAt ?? 0) < (o.endedAt ?? Infinity))
        violations.push(`${w.spec.label} and ${o.spec.label} held together`)
  for (const t of tickets) if (t.spec.arrive < Infinity && t.state === "waiting") violations.push(`${t.spec.label} never entered`)
  return { tickets, hazards, violations }
}

/** Pairs served out of arrival order: j arrived after i, conflicts with it, and entered while i still waited. */
const outOfOrder = (run: Run) => {
  const found: Array<string> = []
  for (const i of run.tickets)
    for (const j of run.tickets) {
      if (j.number <= i.number || j.enteredAt === undefined) continue
      if (i.spec.kind === "r" && j.spec.kind === "r") continue
      const iLive = i.enteredAt === undefined ? (i.endedAt ?? Infinity) : i.enteredAt
      if (j.enteredAt < iLive && (i.spec.killAt ?? Infinity) > j.enteredAt) found.push(`${j.spec.label} before ${i.spec.label}`)
    }
  return found
}

/** Each ticket's wait is at most the holds of the earlier tickets it conflicts with. */
const unbounded = (run: Run) =>
  run.tickets.flatMap((t) => {
    if (t.enteredAt === undefined) return []
    // A reader behind a writer also waits, through it, for the readers before that writer.
    const before = run.tickets.filter((o) => o.number < t.number)
    const bound = before.reduce((sum, o) => sum + o.spec.hold, 0)
    const waited = t.enteredAt - (t.lineAt ?? t.spec.arrive)
    return waited <= bound + 1e-9 ? [] : [`${t.spec.label} waited ${waited} s in line > ${bound} s`]
  })

const maxWait = (run: Run, kind: Kind) =>
  Math.max(0, ...run.tickets.filter((t) => t.spec.kind === kind && t.enteredAt !== undefined).map((t) => t.enteredAt! - t.spec.arrive))

/**
 * 2026-11-22 from 00:00Z: creates arriving through an hour (11 of them waiting at once by 00:47), each cloning for
 * 96-239 s; master moving every ten minutes, so each window's first create starts an advance: a 20 s move (fetch,
 * fast-forward, install, hooks) and, under policy A, a 628 s warm under the exclusive lock.
 */
const tonight = (policy: Policy, seed: number): ReadonlyArray<Spec> => {
  const next = random(seed)
  const creates = Array.from({ length: 22 }, (_, i): Spec => ({
    kind: "r",
    arrive: Math.floor(next() * 3600),
    hold: 96 + Math.floor(next() * 144),
    label: `create ${i}`,
  }))
  const advances = Array.from({ length: 6 }, (_, i): Spec => ({
    kind: "w",
    arrive: i * 600 + 30,
    hold: 20 + (policy === "A" ? 628 : 0),
    // It defers to copies for at most a window, then takes its place in line.
    politeFor: 600,
    label: policy === "A" ? `advance ${i} (move and warm)` : `advance ${i} (move)`,
  }))
  return [...creates, ...advances]
}

/** Arbitrary schedules: readers and writers at random times, some killed waiting or holding. */
const generated = (seed: number): ReadonlyArray<Spec> => {
  const next = random(seed)
  const n = 3 + Math.floor(next() * 30)
  return Array.from({ length: n }, (_, i): Spec => {
    const kind: Kind = next() < 0.25 ? "w" : "r"
    const arrive = Math.floor(next() * 600)
    const hold = 1 + Math.floor(next() * (kind === "w" ? 30 : 240))
    const killAt = next() < 0.15 ? arrive + Math.floor(next() * (hold + 60)) : undefined
    const politeFor = kind === "w" && next() < 0.5 ? Math.floor(next() * 300) : undefined
    return { kind, arrive, hold, ...(killAt === undefined ? {} : { killAt }), ...(politeFor === undefined ? {} : { politeFor }), label: `${kind}${i}` }
  })
}

describe("the base's lock as a ticket queue (a model on a manual clock)", () => {
  test("red first: on main's flock protocol, later creates pass earlier ones, and a sibling's bookkeeping lands inside a copy", () => {
    let passes = 0
    let hazards = 0
    for (let seed = 1; seed <= 40; seed++) {
      const run = simulate("flock", tonight("B", seed), seed)
      passes += outOfOrder(run).length
      hazards += run.hazards.length
    }
    expect(passes).toBeGreaterThan(0)
    expect(hazards).toBeGreaterThan(0)
  })

  test("tonight under tickets: served in arrival order, every wait bounded, no write inside a copy; B waits seconds where A waits a warm", () => {
    const worst = { A: 0, B: 0 }
    for (let seed = 1; seed <= 40; seed++)
      for (const policy of ["A", "B"] as const) {
        const run = simulate("tickets", tonight(policy, seed), seed)
        expect({ seed, policy, out: outOfOrder(run), bound: unbounded(run), bad: run.violations, hazards: run.hazards }).toEqual({
          seed,
          policy,
          out: [],
          bound: [],
          bad: [],
          hazards: [],
        })
        worst[policy] = Math.max(worst[policy], maxWait(run, "r"))
        if (process.env.QUEUE_DEBUG && maxWait(run, "r") > 20) console.log(policy, seed, run.tickets.filter((t) => t.enteredAt !== undefined && t.enteredAt - t.spec.arrive > 20).map((t) => `${t.spec.label} arrive ${t.spec.arrive} line ${t.lineAt} in ${t.enteredAt} end ${t.endedAt}`), run.tickets.filter((t) => t.spec.kind === "w").map((t) => `${t.spec.label} ${t.spec.arrive} line ${t.lineAt} in ${t.enteredAt}`))
      }
    // B: a create waits at most for one move (20 s), or, when an advance whose patience ran out queued behind copies
    // still running, for the rest of those copies (at most one clone, 239 s) and the move; A: for a move and its warm.
    expect(worst.B).toBeLessThanOrEqual(239 + 20)
    expect(worst.A).toBeGreaterThan(600)
    console.log(`tonight, longest wait of a create: policy A ${worst.A} s, policy B ${worst.B} s`)
  })

  test("property: generated schedules with kills keep arrival order, bounded waits and exclusion, and a dead ticket never blocks", () => {
    let killed = 0
    for (let seed = 1; seed <= 500; seed++) {
      const specs = generated(seed)
      const run = simulate("tickets", specs, seed)
      const context = `seed ${seed}`
      expect(outOfOrder(run), context).toEqual([])
      expect(unbounded(run), context).toEqual([])
      expect(run.violations, context).toEqual([])
      expect(run.hazards, context).toEqual([])
      // A dead ticket holds nothing after it died: every ticket that waited on it entered no later than its death
      // plus the holds of the others before it (the bound above), and none is left waiting.
      for (const t of run.tickets.filter((each) => each.state === "dead")) {
        killed++
        expect(t.endedAt, context).toBeLessThanOrEqual(t.spec.killAt!)
      }
      expect(run.tickets.filter((t) => t.state === "waiting" || t.state === "holding"), context).toEqual([])
    }
    expect(killed).toBeGreaterThan(50)
  })

  test("a move killed while it holds: no copy enters the half-moved base; a repair goes first and every create still ends", () => {
    const specs: ReadonlyArray<Spec> = [
      { kind: "w", arrive: 0, hold: 20, killAt: 10, label: "advance (killed)" },
      ...Array.from({ length: 5 }, (_, i): Spec => ({ kind: "r", arrive: 2 + i, hold: 100, label: `c${i}` })),
    ]
    const run = simulate("tickets", specs)
    expect(run.violations).toEqual([])
    const repairs = run.tickets.filter((t) => t.spec.label.startsWith("repair"))
    expect(repairs.length).toBeGreaterThanOrEqual(1)
    const firstRepairEnd = Math.min(...repairs.map((t) => t.endedAt ?? Infinity))
    // Every copy that went in did so after a repair ended.
    for (const t of run.tickets.filter((each) => each.spec.kind === "r" && each.enteredAt !== undefined))
      expect({ label: t.spec.label, after: t.enteredAt! >= firstRepairEnd }).toEqual({ label: t.spec.label, after: true })
    // Each create came again and copied.
    for (let i = 0; i < 5; i++) expect(run.tickets.some((t) => t.spec.label === `c${i} again` && t.state === "done")).toBe(true)
  })

  test("readers batch behind a writer, and a writer is never starved by a stream of readers", () => {
    // A writer arrives while readers keep coming, each overlapping the next: under tickets it enters once the readers
    // before it end, and the readers after it wait for it.
    const stream = Array.from({ length: 40 }, (_, i): Spec => ({ kind: "r", arrive: i * 10, hold: 60, label: `r${i}` }))
    const writer: Spec = { kind: "w", arrive: 105, hold: 20, label: "advance" }
    const run = simulate("tickets", [...stream, writer])
    const w = run.tickets.find((t) => t.spec.label === "advance")!
    expect(w.enteredAt).toBe(100 + 60)
    const after = run.tickets.filter((t) => t.spec.kind === "r" && t.spec.arrive > 105)
    expect(after.every((t) => (t.enteredAt ?? 0) >= 180)).toBe(true)
    // The readers that queued behind it go in together.
    expect(new Set(after.filter((t) => t.spec.arrive < 180).map((t) => t.enteredAt))).toEqual(new Set([180]))
  })
})
