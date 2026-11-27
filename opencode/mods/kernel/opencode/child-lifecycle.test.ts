// A child's row reads only the stored records that can matter to it (child-lifecycle.ts's index),
// never every record of the location, and answers as the full scan did.
import { describe, expect } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { DateTime, Effect, Option, Order, Predicate, Queue, Schema, Stream } from "effect"
import { it } from "effect-bun-test"
import { Fact, Projection, Terminal, decide, evolve, executionActive, forIncarnation, initial, present, workEvidence, type Snapshot, type WorkEvidence } from "../child-lifecycle.ts"
import { make } from "./child-lifecycle.ts"

const DIRECTORY = "/nonexistent/loop-probe-x"
const PREFIX = `child-lifecycle:${DIRECTORY.length}:${DIRECTORY}::`
const ROOT = "ses_root"

interface Session {
  readonly id: string
  readonly parentID: string
  readonly created: number
  busy: Option.Option<number>
  idle: Option.Option<number>
}
type Stored = Projection | number
type Kind = "done" | "running" | "stale" | "shell" | "owner" | "child"
const KINDS: ReadonlyArray<Kind> = ["done", "running", "stale", "shell", "owner", "child"]

const point = (seq: number, at: number) => ({ id: `evt_${seq}`, seq, at })
const factsOf = (kind: Kind, child: string, parent: string): ReadonlyArray<Fact> => {
  const start = Fact.cases.Execution.make({ child, parent, segment: { point: point(1, 10) } })
  const end = Fact.cases.Execution.make({ child, parent, segment: { point: point(2, 20), terminal: Terminal.cases.Ended.make({ outcome: "succeeded", cause: "Unknown" }) } })
  const shell = `sh_${child}`
  switch (kind) {
    case "done": return [start, end]
    case "running": return [Fact.cases.Execution.make({ child, parent, segment: { point: point(1, 30) } })]
    case "stale": return [start]
    case "shell": return [start, end, Fact.cases.Work.make({ child, parent, id: shell, work: { kind: "Shell", running: true, at: 15, native: true, backgrounded: true } })]
    case "owner": return [start, end, Fact.cases.ShellObserved.make({ child, parent, id: shell, startedAt: 15 })]
    case "child": return [start, end, Fact.cases.Work.make({ child, parent, id: `job_${child}`, work: { kind: "Child", running: true, at: 15, native: false, backgrounded: false, startEvent: "evt_job" } })]
  }
}
const busyOf = (kind: Kind) => Option.some(Option.match(Option.liftPredicate(kind, (each) => each === "running"), { onNone: () => 10, onSome: () => 30 }))
const idleOf = (kind: Kind) => Option.filter(Option.some(20), () => kind !== "running")

/** A host over memory: its storage, its sessions, and how often a read scanned or got a session. */
const host = () => {
  const store = new Map<string, Stored>()
  const sessions = new Map<string, Session>()
  const calls = { scan: 0, get: 0 }
  const changed: Array<string> = []
  const infoOf = (session: Session) => ({
    id: session.id, parentID: session.parentID, location: { directory: DIRECTORY }, metadata: {},
    time: {
      created: DateTime.makeUnsafe(session.created), updated: DateTime.makeUnsafe(session.created),
      ...Option.match(session.busy, { onNone: () => ({}), onSome: (at) => ({ busy: DateTime.makeUnsafe(at) }) }),
      ...Option.match(session.idle, { onNone: () => ({}), onSome: (at) => ({ idle: DateTime.makeUnsafe(at) }) }),
    },
  })
  const revOf = (value: Option.Option<Stored>) => Option.match(value, {
    onNone: () => -1,
    onSome: (stored) => Option.getOrElse(Option.map(Schema.decodeUnknownOption(Schema.Struct({ rev: Schema.Int }))(stored), ({ rev }) => rev), () => 0),
  })
  const ctx: Plugin.Context = Object.assign(Object.create(null), {
    location: { directory: DIRECTORY },
    storage: {
      get: (key: string) => Effect.sync(() => store.get(key)),
      set: (key: string, value: Stored) => Effect.sync(() => void store.set(key, value)),
      setIf: (key: string, value: Stored, rev?: number) => Effect.sync(() => {
        const current = revOf(Option.fromUndefinedOr(store.get(key)))
        const matches = Option.match(Option.fromUndefinedOr(rev), { onNone: () => current === -1, onSome: (want) => current === want })
        if (matches) store.set(key, value)
        return matches
      }),
      scan: (input: { readonly prefix: string; readonly after?: string; readonly limit?: number }) => Effect.sync(() => {
        calls.scan++
        const after = Option.getOrElse(Option.fromUndefinedOr(input.after), () => "")
        const matching = [...store.entries()].filter(([key]) => key.startsWith(input.prefix) && key > after).toSorted(([left], [right]) => Order.String(left, right))
        const limit = Option.getOrElse(Option.fromUndefinedOr(input.limit), () => matching.length)
        const entries = matching.slice(0, limit).map(([key, value]) => ({ key, value }))
        if (entries.length < matching.length) return { entries, next: entries[entries.length - 1].key }
        return { entries }
      }),
    },
    session: {
      get: ({ sessionID }: { readonly sessionID: string }) => Effect.suspend(() => {
        calls.get++
        return Option.match(Option.fromUndefinedOr(sessions.get(sessionID)), {
          onNone: () => Effect.fail("no such session"),
          onSome: (session) => Effect.succeed(infoOf(session)),
        })
      }),
    },
    rpc: {
      register: () => Effect.succeed({ events: { emit: (_name: string, data: { readonly child: string }) => Effect.sync(() => void changed.push(data.child)) } }),
    },
  })
  const add = (id: string, parentID: string, kind: Kind, created: number) => {
    sessions.set(id, { id, parentID, created, busy: busyOf(kind), idle: idleOf(kind) })
    const fresh = forIncarnation(initial(id, parentID), parentID, Option.some(created))
    store.set(`${PREFIX}${id}`, factsOf(kind, id, parentID).reduce((state, fact) => evolve(state, { ...fact, seenIn: 1 }), fresh))
  }
  return { ctx, store, sessions, calls, changed, add }
}
type Host = ReturnType<typeof host>

/** The read as it was before the index: every stored record of the location, in key order. */
const readStored = Schema.decodeUnknownOption(Projection)
const snapshotOf = (session: Session): Snapshot => {
  const running = Option.exists(session.busy, (busy) => Option.match(session.idle, { onNone: () => true, onSome: (idle) => busy > idle }))
  return {
    running,
    ...Option.match(session.busy, { onNone: () => ({}), onSome: (busyAt) => ({ busyAt }) }),
    ...Option.match(session.idle, { onNone: () => ({}), onSome: (idleAt) => ({ idleAt }) }),
  }
}
const stored = ({ store }: Host) => [...store.entries()]
  .filter(([key]) => key.startsWith(PREFIX))
  .toSorted(([left], [right]) => Order.String(left, right))
  .flatMap(([key, value]) => Option.toArray(Option.map(readStored(value), (state) => ({ key, state }))))
const ownedBy = ({ sessions }: Host, parent: string, child: string) => {
  let id = parent
  for (let depth = 0; depth < 32; depth++) {
    if (id === child) return true
    const found = Option.fromUndefinedOr(sessions.get(id))
    if (Option.isNone(found)) return false
    id = found.value.parentID
  }
  return false
}
const isLive = Predicate.or(Predicate.isTagged("Running"), Predicate.isTagged("Continuing"))
const fullScanWork = (world: Host, child: string): Option.Option<WorkEvidence> => {
  for (const { state } of stored(world)) {
    if (state.child === child || !(executionActive(state) || Option.isSome(workEvidence(state)))) continue
    if (!ownedBy(world, state.parent, child)) continue
    const session = Option.fromUndefinedOr(world.sessions.get(state.child))
    if (Option.isNone(session)) continue
    const current = forIncarnation(state, session.value.parentID, Option.some(session.value.created))
    const choice = decide(current, snapshotOf(session.value), 1)
    if (isLive(choice.phase)) return Option.some({ kind: "Child", facts: choice.facts })
  }
  return Option.none()
}
const fullScanOwner = (world: Host, shell: string) => Option.map(
  Option.fromUndefinedOr(stored(world).find(({ state }) => Boolean(state.work?.[shell]?.running || (state.shellOwners && Object.hasOwn(state.shellOwners, shell))))),
  ({ key }) => key,
)
const fullScanRow = (world: Host, child: string) => {
  const session = Option.getOrThrow(Option.fromUndefinedOr(world.sessions.get(child)))
  const prior = Option.getOrElse(readStored(world.store.get(`${PREFIX}${child}`)), () => initial(child, session.parentID))
  const state = forIncarnation(prior, session.parentID, Option.some(session.created))
  let background = workEvidence(state)
  if (Option.isNone(background) && !executionActive(state)) background = fullScanWork(world, child)
  const view = present(state, { ...snapshotOf(session), stopUncertain: Option.isSome(Option.fromUndefinedOr(state.stopAfter)) }, 1, background)
  return { ...view, basis: Option.getOrElse(Option.fromUndefinedOr(view.basis), () => "current" as const) }
}

/** A lifecycle on the host, and a way to feed it host events and wait until each is folded. */
const start = Effect.fn("ChildLifecycleTest.start")(function* (world: Host) {
  const events = yield* Queue.unbounded<Readonly<Record<string, Schema.Json>>>()
  const lifecycle = yield* make(world.ctx, () => Stream.fromQueue(events))
  let seq = 100
  world.sessions.set("ses_flush", { id: "ses_flush", parentID: ROOT, created: 1, busy: Option.none(), idle: Option.none() })
  const fold = Effect.fn("ChildLifecycleTest.fold")(function* (event: Readonly<Record<string, Schema.Json>>) {
    seq++
    const before = world.changed.length
    yield* Queue.offer(events, event)
    // A later event the lifecycle always records: once it is announced, the first was folded.
    yield* Queue.offer(events, {
      id: `evt_flush_${seq}`, created: seq, type: "session.execution.started", location: { directory: DIRECTORY },
      durable: { aggregateID: "ses_flush", seq, version: 1 }, data: { sessionID: "ses_flush" },
    })
    while (!world.changed.slice(before).includes("ses_flush")) yield* Effect.yieldNow
  })
  const row = (child: string) => lifecycle.read(child).pipe(
    Effect.map((read) => Option.getOrThrow(Option.flatMap(read, ({ observation }) => observation))),
  )
  return { lifecycle, fold, row }
})

const random = (seed: number) => {
  let state = seed
  return (below: number) => {
    state = (state * 16807) % 2147483647
    return state % below
  }
}

describe("a child's row", () => {
  it.effect("costs no scan and one session read per idle child, whatever the number of stored records", () =>
    Effect.scoped(Effect.gen(function* () {
      const stored = 2000
      const read = 200
      const world = host()
      world.sessions.set(ROOT, { id: ROOT, parentID: "", created: 1, busy: Option.none(), idle: Option.none() })
      for (let index = 0; index < stored; index++) world.add(`ses_idle_${String(index).padStart(4, "0")}`, ROOT, "done", 5)
      // Live work elsewhere: under another root, so it reaches none of these rows.
      for (let index = 0; index < 4; index++) world.add(`ses_live_${index}`, "ses_other", "running", 5)
      world.sessions.set("ses_other", { id: "ses_other", parentID: "ses_elsewhere", created: 1, busy: Option.none(), idle: Option.none() })
      const { row } = yield* start(world)
      yield* row("ses_idle_0000")
      world.calls.scan = 0
      world.calls.get = 0
      for (let index = 1; index <= read; index++) yield* row(`ses_idle_${String(index).padStart(4, "0")}`)
      // Per child: its own session, then one read per live record indexed (4 here) and an ancestry
      // walk only for one that is live (from its parent up: 2 here); never a scan.
      expect({ scans: world.calls.scan / read, gets: world.calls.get / read }).toEqual({ scans: 0, gets: 1 + 4 * (1 + 2) })
    })),
  )

  it.effect("and a shell's owner answer as the full scan of the stored records did", () =>
    Effect.scoped(Effect.gen(function* () {
      for (let seed = 1; seed <= 25; seed++) {
        const next = random(seed * 7919)
        const world = host()
        world.sessions.set(ROOT, { id: ROOT, parentID: "", created: 1, busy: Option.none(), idle: Option.none() })
        const ids: Array<string> = []
        // A live grandchild under an idle child, and a shell owner, in every set.
        world.add("ses_a_idle", ROOT, "done", 5)
        world.add("ses_b_live", "ses_a_idle", "running", 5)
        world.add("ses_c_owner", ROOT, "owner", 5)
        ids.push("ses_a_idle", "ses_b_live", "ses_c_owner")
        for (let index = 0; index < 30; index++) {
          const id = `ses_${String(next(1000)).padStart(3, "0")}_${index}`
          const parent = Option.getOrElse(Option.fromUndefinedOr(ids[next(ids.length + 3)]), () => ROOT)
          world.add(id, parent, KINDS[next(KINDS.length)], 5)
          ids.push(id)
        }
        const { fold, row } = yield* start(world)
        const compare = Effect.fn("ChildLifecycleTest.compare")(function* () {
          for (const id of ids) {
            const expected = fullScanRow(world, id)
            const actual = yield* row(id)
            expect(actual).toEqual({ ...expected, revision: actual.revision })
          }
        })
        yield* compare()
        expect(fullScanRow(world, "ses_a_idle").phase._tag).toBe("Continuing")
        // A shell's exit reaches the first owner in key order, and only it.
        for (const shell of ["sh_ses_c_owner", ...ids.flatMap((id) => Option.toArray(Option.liftPredicate(`sh_${id}`, () => next(3) === 0)))]) {
          const owner = fullScanOwner(world, shell)
          const before = new Map(stored(world).map(({ key, state }) => [key, state.rev]))
          yield* fold({ id: `evt_exit_${shell}`, created: 50, type: "shell.exited", location: { directory: DIRECTORY }, data: { id: shell } })
          const moved = stored(world).flatMap(({ key, state }) =>
            Option.toArray(Option.liftPredicate(key, () => key !== `${PREFIX}ses_flush` && !Option.contains(Option.fromUndefinedOr(before.get(key)), state.rev))))
          expect(moved.every((key) => Option.contains(owner, key))).toBe(true)
          if (shell === "sh_ses_c_owner") expect(moved).toEqual(Option.toArray(owner))
        }
        // Running work that ends leaves the index; the rows still answer as the full scan does.
        for (const id of ids.filter((each) => Option.isNone(Option.filter(Option.fromUndefinedOr(world.sessions.get(each)), (session) => Option.isNone(session.idle))))) {
          const session = Option.getOrThrow(Option.fromUndefinedOr(world.sessions.get(id)))
          session.idle = Option.some(40)
          yield* fold({
            id: `evt_end_${id}`, created: 40, type: "session.execution.succeeded", location: { directory: DIRECTORY },
            durable: { aggregateID: id, seq: 3, version: 1 }, data: { sessionID: id },
          })
        }
        yield* compare()
      }
    })),
  )
})
