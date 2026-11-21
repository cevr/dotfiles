// A model of how `workrift create` shares a base's locks with the base's advance (fast-forward, install,
// warm), run on a manual clock: the protocol before this change (every create takes the base's one lock
// exclusively and advances the base under it) and after (copies share the lock; an advance moves the base
// under it exclusively, behind a turnstile, and warms it with only its own advance lock held, in the
// background). The numbers of the measured schedule are the Bite workbox's of 2026-11-21 22:01Z
// (/tmp/vperf2 logs): a fast-forward of 30 s, an install of 16 s, a warm of 628 s, `work new`'s clone of
// 96 to 239 s each.
import { describe, expect, test } from "bun:test"

type Mode = "shared" | "exclusive"
type Protocol = "before" | "after"

interface Base {
  head: number
  installed: number
  warmed: number | null
  moving: boolean
  stamp: number
}

interface Copy {
  readonly create: number
  readonly head: number
  readonly installed: number
  readonly warmed: number | null
  readonly start: number
}

interface CreateSpec {
  readonly arrive: number
  readonly fetch: number
  readonly clone: number
}

interface Timing {
  ff: number
  install: number
  warm: number
}

/** One run of the model. `kills` cuts the advance that is running at each of those times. */
const simulate = (
  protocol: Protocol,
  creates: ReadonlyArray<CreateSpec>,
  timing: Timing,
  options: { readonly turnstile?: boolean; readonly kills?: ReadonlyArray<number>; readonly originAt?: ReadonlyArray<readonly [number, number]>; readonly window?: number } = {},
) => {
  const turnstileOn = options.turnstile ?? true
  const window = options.window ?? 600
  const base: Base = { head: 0, installed: 0, warmed: 0, moving: false, stamp: -Infinity }
  let origin = 1
  const originAt = [...(options.originAt ?? [])]
  let now = 0
  // Locks: holders by process id; waiters in arrival order (flock wakes them in no promised order; FIFO is the
  // kind reading of the measured log).
  const main = { shared: new Set<number>(), exclusive: null as number | null }
  let turnstile: number | null = null
  let advanceHolder: number | null = null
  const queue: Array<{ pid: number; want: "main-shared" | "main-exclusive" | "turnstile"; resume: () => void }> = []
  const timers: Array<{ at: number; pid: number; run: () => void }> = []
  const killed = new Set<number>()
  const violations: Array<string> = []
  const locked = new Map<number, number>()
  const done = new Map<number, number>()
  const copies: Array<Copy> = []
  const advances: Array<{ pid: number; start: number; end?: number; exclusiveAsked?: number; exclusiveGot?: number; head?: number; killed?: boolean }> = []
  let running = 0
  let repairs = 0
  let nextPid = 1000

  const at = (delay: number, pid: number, run: () => void) => timers.push({ at: now + delay, pid, run })
  const free = (want: string, pid: number) =>
    want === "turnstile"
      ? turnstile === null
      : want === "main-shared"
        ? main.exclusive === null
        : main.exclusive === null && main.shared.size === 0 && (turnstileOn ? turnstile === pid || turnstile === null : true)
  const take = (want: string, pid: number) => {
    if (want === "turnstile") turnstile = pid
    else if (want === "main-shared") main.shared.add(pid)
    else main.exclusive = pid
  }
  const pump = () => {
    let moved = true
    while (moved) {
      moved = false
      for (const [i, waiter] of queue.entries()) {
        if (free(waiter.want, waiter.pid)) {
          queue.splice(i, 1)
          take(waiter.want, waiter.pid)
          waiter.resume()
          moved = true
          break
        }
      }
    }
  }
  const acquire = (pid: number, want: "main-shared" | "main-exclusive" | "turnstile", resume: () => void) => {
    if (queue.length === 0 && free(want, pid)) {
      take(want, pid)
      resume()
    } else queue.push({ pid, want, resume })
  }
  const releaseAll = (pid: number) => {
    main.shared.delete(pid)
    if (main.exclusive === pid) main.exclusive = null
    if (turnstile === pid) turnstile = null
    if (advanceHolder === pid) advanceHolder = null
    pump()
  }
  const setMoving = (value: boolean) => {
    if (value && main.shared.size > 0) violations.push(`t=${now}: the base moves while ${main.shared.size} copies read it`)
    base.moving = value
  }
  const startCopy = (create: number) => {
    if (base.moving) violations.push(`t=${now}: create ${create} copies a base in the middle of a move`)
    if (main.exclusive !== null && main.exclusive !== create) violations.push(`t=${now}: create ${create} copies while ${main.exclusive} moves the base`)
    copies.push({ create, head: base.head, installed: base.installed, warmed: base.warmed, start: now })
  }

  // The base's advance in the protocol after: one at a time (its own lock, tried once), the move under the
  // exclusive lock behind the turnstile, the warm with no base lock.
  const advance = () => {
    const pid = nextPid++
    if (advanceHolder !== null) return
    advanceHolder = pid
    const record: (typeof advances)[number] = { pid, start: now }
    advances.push(record)
    running++
    if (running > 1) violations.push(`t=${now}: two advances run at once`)
    const end = () => {
      running--
      record.end = now
      releaseAll(pid)
    }
    const warm = () => {
      if (base.warmed === base.head) return end()
      base.warmed = null
      at(timing.warm, pid, () => {
        base.warmed = base.head
        base.stamp = now
        end()
      })
    }
    const move = () => {
      setMoving(true)
      at(timing.ff, pid, () => {
        base.head = origin
        at(timing.install, pid, () => {
          base.installed = base.head
          setMoving(false)
          record.head = base.head
          main.exclusive = null
          pump()
          warm()
        })
      })
    }
    const exclusive = () => {
      record.exclusiveAsked = now
      acquire(pid, "main-exclusive", () => {
        record.exclusiveGot = now
        if (turnstileOn && turnstile === pid) turnstile = null
        // Under the lock: nothing to do when another advance already brought the base to origin.
        if (base.head === origin && !base.moving) {
          main.exclusive = null
          pump()
          return warm()
        }
        move()
      })
    }
    if (turnstileOn) acquire(pid, "turnstile", exclusive)
    else exclusive()
    return pid
  }

  const create = (index: number, spec: CreateSpec) => {
    const pid = index
    const copy = () => {
      startCopy(pid)
      at(spec.clone, pid, () => {
        const due = base.head !== origin && now - base.stamp >= window
        releaseAll(pid)
        if (due && advanceHolder === null) advance()
        done.set(pid, now)
      })
    }
    if (protocol === "before") {
      acquire(pid, "main-exclusive", () => {
        locked.set(pid, now)
        const behind = base.head !== origin && now - base.stamp >= window
        if (!behind) return copy()
        setMoving(true)
        at(timing.ff, pid, () => {
          base.head = origin
          at(timing.install, pid, () => {
            base.installed = base.head
            base.warmed = null
            at(timing.warm, pid, () => {
              base.warmed = base.head
              base.stamp = now
              setMoving(false)
              copy()
            })
          })
        })
      })
      return
    }
    const shared = () =>
      acquire(pid, "main-shared", () => {
        // A move a kill cut short: no copy of it. Repair (the install again, under the exclusive lock), then copy.
        if (base.moving) {
          repairs++
          releaseAll(pid)
          const repair = () =>
            acquire(pid, "main-exclusive", () => {
              if (turnstileOn && turnstile === pid) turnstile = null
              at(timing.install, pid, () => {
                base.installed = base.head
                base.moving = false
                releaseAll(pid)
                enter()
              })
            })
          if (turnstileOn) acquire(pid, "turnstile", repair)
          else repair()
          return
        }
        if (!locked.has(pid)) locked.set(pid, now)
        copy()
      })
    const enter = () => {
      if (turnstileOn)
        acquire(pid, "turnstile", () => {
          turnstile = null
          pump()
          shared()
        })
      else shared()
    }
    enter()
  }

  for (const [i, spec] of creates.entries()) timers.push({ at: spec.arrive + spec.fetch, pid: i, run: () => create(i, spec) })
  for (const [when, head] of originAt) timers.push({ at: when, pid: -1, run: () => (origin = head) })
  for (const when of options.kills ?? [])
    timers.push({
      at: when,
      pid: -2,
      run: () => {
        const current = advances.find((each) => each.end === undefined)
        if (current === undefined) return
        killed.add(current.pid)
        current.killed = true
        current.end = now
        running--
        // The kernel drops a dead process's file locks and its waits; its unfinished steps never come.
        for (let i = queue.length - 1; i >= 0; i--) if (queue[i]?.pid === current.pid) queue.splice(i, 1)
        releaseAll(current.pid)
      },
    })
  while (timers.length > 0) {
    timers.sort((a, b) => a.at - b.at)
    const next = timers.shift()
    if (next === undefined) break
    now = next.at
    if (killed.has(next.pid)) continue
    next.run()
  }
  for (const [i, spec] of creates.entries()) if (!done.has(i)) violations.push(`create ${i} never ended (arrived ${spec.arrive})`)
  if (main.exclusive !== null || main.shared.size > 0 || turnstile !== null || advanceHolder !== null) violations.push("a lock is still held at the end")
  const waited = creates.map((spec, i) => (locked.get(i) ?? Infinity) - (spec.arrive + spec.fetch))
  return { base, copies, advances, violations, waited, locked, done, repairs }
}

const measuredTiming: Timing = { ff: 30, install: 16, warm: 628 }
/** 22:00:57Z = 0: the holder (scratch-vfy-21699-r2), lab-replay, offprice, vitrine, whole-publish, in the order they got the lock. */
const measured: ReadonlyArray<CreateSpec> = [
  { arrive: 0, fetch: 6, clone: 153 },
  { arrive: 29, fetch: 3, clone: 168 },
  { arrive: 35, fetch: 2, clone: 96 },
  { arrive: 42, fetch: 2, clone: 239 },
  { arrive: 50, fetch: 2, clone: 175 },
]

describe("the base's lock under seven creates and an advance (a model on a manual clock)", () => {
  test("before: the measured schedule comes back, every create queued behind the advance's warm and the clones before it", () => {
    const run = simulate("before", measured, measuredTiming)
    expect(run.violations).toEqual([])
    // Measured, in s after 22:00:57Z, when each got the lock: 22:01:03, 22:14:55, 22:17:43, 22:19:19, 22:23:18
    // (the work registry's `since` of the one before, and each log's 'locked' line).
    const measuredLocked = [6, 838, 1006, 1102, 1341]
    for (const [i, seconds] of measuredLocked.entries()) expect({ i, off: Math.abs((run.locked.get(i) ?? Infinity) - seconds) <= 20 }).toEqual({ i, off: true })
    // whole-publish's own wait: 1291 s from its start.
    expect(Math.abs((run.locked.get(4) ?? 0) - 50 - 1291)).toBeLessThanOrEqual(20)
    // The rule this change keeps: every waiter is 'locked' within a few seconds. Before, it does not hold.
    expect(Math.max(...run.waited)).toBeGreaterThan(1000)
  })

  test("after: every create of the measured schedule is 'locked' within a few seconds, the advance moves the base once and warms it once", () => {
    const run = simulate("after", measured, measuredTiming)
    expect(run.violations).toEqual([])
    expect(Math.max(...run.waited)).toBeLessThanOrEqual(3)
    expect(run.advances.filter((each) => !each.killed)).toHaveLength(1)
    expect(run.base).toMatchObject({ head: 1, installed: 1, warmed: 1, moving: false })
    // The copies read the base before it moved: consistent, installed for the head they copy.
    for (const copy of run.copies) expect(copy.installed).toBe(copy.head)
  })

  test("after: a create started once an advance is done copies what it made", () => {
    const run = simulate("after", [...measured, { arrive: 2000, fetch: 2, clone: 100 }], measuredTiming)
    expect(run.violations).toEqual([])
    const advance = run.advances[0]
    expect(advance?.end).toBeLessThan(2000)
    expect(run.copies.find((copy) => copy.create === measured.length)).toMatchObject({ head: 1, installed: 1, warmed: 1 })
  })

  test("after: a steady stream of copies never starves the advance: the turnstile gives it the lock once the copies in flight end", () => {
    const stream = Array.from({ length: 60 }, (_, i) => ({ arrive: i * 10, fetch: 1, clone: 150 }))
    const run = simulate("after", stream, measuredTiming)
    expect(run.violations).toEqual([])
    const advance = run.advances[0]
    expect((advance?.exclusiveGot ?? Infinity) - (advance?.exclusiveAsked ?? 0)).toBeLessThanOrEqual(150)
    // Without the turnstile, the copies that keep arriving hold the shared lock without a gap: the advance waits for all of them.
    const bare = simulate("after", stream, measuredTiming, { turnstile: false })
    const starved = bare.advances[0]
    expect((starved?.exclusiveGot ?? Infinity) - (starved?.exclusiveAsked ?? 0)).toBeGreaterThan(400)
  })

  /** mulberry32, so a failing case runs again from its seed. */
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  test("after, property: any arrivals, clone times, landings on origin and kills of the advance keep every invariant", () => {
    let repaired = 0
    for (let seed = 1; seed <= 300; seed++) {
      const next = random(seed)
      const n = 1 + Math.floor(next() * 12)
      const creates = Array.from({ length: n }, () => ({ arrive: Math.floor(next() * 3000), fetch: 1 + Math.floor(next() * 5), clone: 1 + Math.floor(next() * 240) }))
      // Landings on origin's main: its head only grows.
      const originAt = Array.from({ length: Math.floor(next() * 4) }, () => Math.floor(next() * 3000))
        .sort((a, b) => a - b)
        .map((when, i) => [when, i + 2] as const)
      const kills = Array.from({ length: Math.floor(next() * 3) }, () => Math.floor(next() * 3000))
      const timing = { ff: 1 + Math.floor(next() * 40), install: 1 + Math.floor(next() * 200), warm: 1 + Math.floor(next() * 700) }
      const run = simulate("after", creates, timing, { originAt, kills, window: Math.floor(next() * 900) })
      const context = `seed ${seed}`
      repaired += run.repairs
      // Never a copy of a half-moved base; never two advances at once; every create ends; no lock outlives its holder.
      expect(run.violations, context).toEqual([])
      // Every copy is of a base installed for its own head (a killed install is repaired before any copy).
      for (const copy of run.copies) expect(copy.installed, context).toBe(copy.head)
      // A create that starts after an advance's end copies at least that advance's head.
      for (const advance of run.advances.filter((each) => !each.killed && each.end !== undefined && each.head !== undefined))
        for (const copy of run.copies.filter((each) => each.start > (advance.end ?? Infinity))) expect(copy.head, context).toBeGreaterThanOrEqual(advance.head ?? 0)
      // A create waits only for a move (the fast-forward and the install) and the copies in flight before it, never a warm.
      for (const wait of run.waited) expect(wait, context).toBeLessThanOrEqual(timing.ff + timing.install + 240 + timing.install)
    }
    // The cases did reach a move a kill cut short, and the copies after it repaired the base first.
    expect(repaired).toBeGreaterThan(0)
  })
})
