// The seam between the acceptance test (record-model.sim.test.ts) and the thing under test: the SQLite store on a
// scratch file behind the record's handlers, with `World` behind the memory MainLine (the default branch, in the order
// its commits landed) and the clock, owners and root the plugin reads. `reopen` is a server and kernel restart: a NEW
// store object on the same file, nothing carried in memory. Every call reads the store; within one call's answer a
// snapshot read once serves the call's reads, and any write drops it.
//
// `model` runs the reference model as the subject (the test's own check: green), and each mutant a broken one (each
// must go red): forgets-on-restart, drops-reordered, wakes-twice, silent-orphan, closes-unlanded.
import { Array as Arr, Effect, Match, Option, Order, Result } from "effect"
import { factsOf } from "@dotfiles/opencode-orchestrate/commitments-tool"
import * as MemoryMainLine from "@dotfiles/opencode-orchestrate/memory/main-line"
import {
  type Actor,
  type AfterItem,
  Command,
  isoOf,
  noticesOf,
  openOf,
  PartInput,
  type RecordEvent,
  type Snapshot,
  type StoredEvent,
  wordKey,
} from "@dotfiles/opencode-orchestrate/record"
import { type CommitmentRecord, MainLine } from "@dotfiles/opencode-orchestrate/service"
import * as SqliteRecord from "@dotfiles/opencode-orchestrate/sqlite/record"
import { checkOf, checkpointOf, type Facts, passedOf } from "@dotfiles/opencode-orchestrate/standing"
import { type Answer, type Happened, type HappenedType, makeModel, okOf, refused, sorted, type Subject, type Trigger, type Woke, type World } from "./record-model.ts"

export interface Opened {
  readonly subject: Subject
  /** A restart: a fresh subject over the same durable file. */
  readonly reopen: () => Subject
  /** The file closed, at the end of a seed. */
  readonly close: () => void
}

const RUN = "r1"
const CHECKOUT = "/world"
const ROOT_SHA = "0".repeat(40)
/** The model's commit name (`s1`, …) as a commit the record takes: its bytes in hex, one name one commit (the record holds a commit to 7–40 hex digits). */
const shaOf = (name: string): string => Buffer.from(name).toString("hex").padEnd(40, "0")

const afterOf = (trigger: Trigger): ReadonlyArray<AfterItem> =>
  Match.value(trigger).pipe(
    Match.when({ kind: "now" }, (): ReadonlyArray<AfterItem> => []),
    Match.when({ kind: "main" }, (main) => [{ kind: "commit-on-main" as const, ref: shaOf(main.commit) }]),
    Match.when({ kind: "done" }, (done) => [{ kind: "commitment-closed" as const, ref: done.id }]),
    Match.when({ kind: "at" }, (at) => [{ kind: "date" as const, ref: isoOf(at.ms) }]),
    Match.when({ kind: "manual" }, (manual) => [{ kind: "manual" as const, ref: manual.word }]),
    Match.exhaustive,
  )

/** The world's default branch as the memory MainLine holds it: a root, then each commit in the order it landed. */
const mainLineOf = (world: World) =>
  MemoryMainLine.layer(() =>
    Option.some({ branch: "main", line: [ROOT_SHA, ...[...world.main].map(shaOf)].map((sha) => ({ sha, subject: sha, merged: [] })) }),
  )

const HAPPENED: ReadonlyArray<HappenedType> = ["promised", "assigned", "ordered", "released", "claimed", "landed", "decided", "reopened", "woke"]

const happenedOf = (event: StoredEvent): ReadonlyArray<Happened> =>
  Option.toArray(Option.map(Arr.findFirst(HAPPENED, (type) => type === event.happening._tag), (type) => ({ type, by: event.actor.id })))

const handBackName = (id: number | string): string => `h${id}`

/** The store's subject over `world`, on the store `store`. */
const storeSubject = (store: CommitmentRecord["Service"], world: World): Subject => {
  const cache = { snapshot: Option.none<Snapshot>(), events: Option.none<ReadonlyArray<StoredEvent>>() }
  const read = (): Snapshot =>
    Option.getOrElse(cache.snapshot, () => {
      const snapshot = Effect.runSync(Effect.orDie(store.read))
      cache.snapshot = Option.some(snapshot)
      return snapshot
    })
  const events = (): ReadonlyArray<StoredEvent> =>
    Option.getOrElse(cache.events, () => {
      const all = Effect.runSync(Effect.orDie(store.events))
      cache.events = Option.some(all)
      return all
    })
  const run = (command: Command, actor: Actor): Result.Result<ReadonlyArray<RecordEvent>, string> => {
    cache.snapshot = Option.none()
    cache.events = Option.none()
    const done = Effect.runSync(Effect.result(store.run(command, { actor, now: world.now })))
    return Result.mapBoth(done, { onFailure: (failed) => failed._tag, onSuccess: (each) => each.events })
  }
  /** The root's words the record does not hold yet, given: the world's words are the root's. */
  const syncWords = () => {
    const held = read()
    for (const word of [...world.words].filter((each) => !held.words.has(wordKey(RUN, each)))) run(Command.cases.word.make({ run: RUN, word }), { id: "root", role: "root" })
  }
  const answered = <A>(done: Result.Result<ReadonlyArray<RecordEvent>, string>, ok: (events: ReadonlyArray<RecordEvent>) => A): Answer<A> =>
    Result.match(done, { onFailure: (why) => refused(why), onSuccess: (each) => ({ ok: ok(each) }) })
  const facts = (snapshot: Snapshot): Facts => {
    const gone = (owners: ReadonlyArray<string>) => Effect.succeed(new Set(owners.filter((owner) => !world.alive.has(owner))))
    return Effect.runSync(
      Effect.gen(function* () {
        return yield* factsOf(yield* MainLine, CHECKOUT, gone, snapshot, world.now)
      }).pipe(Effect.provide(mainLineOf(world))),
    )
  }
  const root = (by: string): Actor => ({ id: by, role: "root" })
  return {
    add: (input) => {
      syncWords()
      const sourceKind = Option.getOrElse(Option.as(Option.liftPredicate(input, (each) => each.fromOwner), "owner-answer" as const), () => "plan-part" as const)
      const parts = input.parts.map((part) => PartInput.make({ id: part.id, title: part.text }))
      return answered(run(Command.cases.add.make({ run: RUN, sourceKind, sourceRef: input.source, parts }), root(input.by)), () => input.parts.map((part) => part.id))
    },
    assign: (input) => {
      syncWords()
      const command = Command.cases.assign.make({ id: input.id, ownerLane: input.owner, ownerSession: Option.none(), after: input.startOn.flatMap(afterOf), reviewBy: Option.some(input.reviewBy) })
      return answered(run(command, root(input.by)), () => true as const)
    },
    order: (input) => {
      syncWords()
      return answered(run(Command.cases.order.make({ ownerLane: input.owner, ids: input.ids }), root(input.by)), () => openOf(read(), input.owner))
    },
    release: (input) => answered(run(Command.cases.release.make({ id: input.id }), root(input.by)), () => true as const),
    decide: (input) => answered(run(Command.cases.decide.make({ id: input.id, why: input.why }), { id: input.by, role: input.role }), () => true as const),
    reopen: (input) => answered(run(Command.cases.reopen.make({ id: input.id }), root(input.by)), () => true as const),
    notices: () => noticesOf(read()),
    seen: (id) => void run(Command.cases.seen.make({ id }), { id: "owner", role: "owner" }),
    handBack: (input) => {
      const command = Command.cases.hand_back.make({ run: RUN, ownerLane: input.owner, role: "implementor", session: input.by, verdict: "ready", head: Option.some(shaOf(input.head)), claims: input.ids })
      return answered(run(command, { id: input.by, role: "worker" }), (each) =>
        Option.getOrElse(Option.map(Arr.findFirst(each, (event) => event.subjectKind === "hand_back"), (event) => handBackName(event.subjectId)), () => ""),
      )
    },
    route: (input) => {
      const id = Number(input.handBack.slice(1))
      return answered(run(Command.cases.route.make({ handBack: id, as: input.as }), root(input.by)), () => true as const)
    },
    tick: (): Woke => {
      syncWords()
      const now = facts(read())
      const pass = Command.cases.pass.make({ onMain: [...now.onMain], gone: [...now.gone], root: world.root })
      const passed = Result.map(run(pass, { id: "plugin", role: "plugin" }), passedOf)
      return { woke: Result.getOrElse(Result.map(passed, (each) => Option.toArray(each.woke)), () => []) }
    },
    check: () => {
      syncWords()
      const snapshot = read()
      const check = checkOf(snapshot, facts(snapshot))
      return { ...check, unrouted: sorted(check.unrouted.map(handBackName)) }
    },
    checkpoint: () => {
      syncWords()
      const snapshot = read()
      const point = checkpointOf(snapshot, facts(snapshot))
      return { ...point, unrouted: sorted(point.unrouted.map(handBackName)) }
    },
    state: (id) => Option.map(Option.fromUndefinedOr(read().commitments.get(id)), (row) => row.state),
    history: (id) => events().flatMap((event) => Arr.filter(happenedOf(event), () => event.subjectKind === "commitment" && event.subjectId === id)),
    ids: () => Arr.sort([...read().commitments.keys()], Order.String),
  }
}

/**
 * The SQLite record at `path` (a file `SqliteRecord.open` made and migrated, as the plugin's start does) as the subject;
 * `reopen` closes its connection and attaches a new connection and store to the file.
 */
export const built = (path: string, world: World): Opened => {
  const held = { connected: SqliteRecord.reattached(path) }
  return {
    subject: storeSubject(held.connected.store, world),
    reopen: () => {
      held.connected.close()
      held.connected = SqliteRecord.reattached(path)
      return storeSubject(held.connected.store, world)
    },
    close: () => held.connected.close(),
  }
}

/** The model kept across "restarts" by holding the one object: what a durable store must look like from outside. */
const model = (world: World): Opened => {
  const subject = makeModel(world)
  return { subject, reopen: () => subject, close: () => {} }
}

const kept = (subject: Subject): Opened => ({ subject, reopen: () => subject, close: () => {} })

/** An order to an owner silently drops that owner's other open commitments (the audit's cause 2). */
const dropsReordered = (world: World): Opened => {
  const subject = makeModel(world)
  return kept({
    ...subject,
    order: (input) => {
      const answer = subject.order(input)
      const dropped = Option.getOrElse(okOf(answer), (): ReadonlyArray<string> => [])
      for (const id of dropped.filter((each) => !input.ids.includes(each))) subject.decide({ id, why: "superseded by the new order", by: "plugin", role: "root" })
      return answer
    },
  })
}

/** A trigger that turned true wakes the root on every pass. */
const wakesTwice = (world: World): Opened => {
  const subject = makeModel(world)
  const quiet: Woke = { woke: [] }
  const last = { woke: quiet }
  return kept({
    ...subject,
    tick: () => {
      const now = subject.tick()
      const answer = Arr.match(now.woke, { onEmpty: () => last.woke, onNonEmpty: () => now })
      last.woke = Arr.match(now.woke, { onEmpty: (): Woke => ({ woke: [] }), onNonEmpty: () => now })
      return answer
    },
  })
}

/** A commitment whose owner ended is still shown as held (the audit's cause 4). */
const silentOrphan = (world: World): Opened => {
  const subject = makeModel(world)
  return kept({
    ...subject,
    check: () => {
      const now = subject.check()
      return { ...now, orphaned: [], held: sorted([...now.held, ...now.orphaned]) }
    },
  })
}

/** A hand-back's claim closes the commitment before its commit is on the default branch. */
const closesUnlanded = (world: World): Opened => {
  const subject = makeModel(world)
  const landedEarly = new Set<string>()
  return kept({
    ...subject,
    handBack: (input) => {
      const answer = subject.handBack(input)
      if ("ok" in answer) for (const id of input.ids) landedEarly.add(id)
      return answer
    },
    state: (id) => Option.map(subject.state(id), (state) => Option.getOrElse(Option.as(Option.liftPredicate(state, (each) => landedEarly.has(id) && each === "open"), "landed" as const), () => state)),
  })
}

export const SUBJECTS: ReadonlyMap<string, (path: string, world: World) => Opened> = new Map([
  ["", built],
  ["model", (_path: string, world: World) => model(world)],
  ["forgets-on-restart", (_path: string, world: World) => ({ subject: makeModel(world), reopen: () => makeModel(world), close: () => {} })],
  ["drops-reordered", (_path: string, world: World) => dropsReordered(world)],
  ["wakes-twice", (_path: string, world: World) => wakesTwice(world)],
  ["silent-orphan", (_path: string, world: World) => silentOrphan(world)],
  ["closes-unlanded", (_path: string, world: World) => closesUnlanded(world)],
])
