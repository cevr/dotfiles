// Where each open commitment stands, computed at every read and never stored (derive, don't sync): unowned, orphaned,
// overdue, due or held, the first that applies. The check lists the first four; only held is quiet. The plugin's pass
// (`decidePass`) is pure too: it lands what a hand-back claimed and the default branch holds, then wakes the run's root
// once for each commitment newly due. The facts it reads from outside (the clock, which commits are on the default
// branch, which owners are gone, the run's root) are gathered by the caller through the contracts.
import { Array as Arr, Match, Option, Order, Result } from "effect"
import { type Command, type Commitment, type Context, decide, fold, Happening, isoOf, msOf, type Prerequisite, type RecordEvent, type RecordRefused, ROOT, type Snapshot } from "./record.ts"

export const STANDINGS = ["unowned", "orphaned", "overdue", "due", "held"] as const
export type Standing = (typeof STANDINGS)[number]
/** The standings the check lists. */
export const LISTED: ReadonlyArray<Standing> = ["unowned", "orphaned", "overdue", "due"]

/** What the plugin reads from outside the record at a read. */
export interface Facts {
  readonly now: number
  /** The commits asked about (`asked`) that are on the default branch. */
  readonly onMain: ReadonlySet<string>
  /** The owners asked about (`ownersOf`) that are gone: a lane removed. `root` never is. */
  readonly gone: ReadonlySet<string>
}

const holds = (snapshot: Snapshot, facts: Facts) => (prerequisite: Prerequisite): boolean =>
  Match.value(prerequisite.kind).pipe(
    Match.when("commit-on-main", () => facts.onMain.has(prerequisite.ref)),
    Match.when("date", () => facts.now >= msOf(prerequisite.ref)),
    Match.when("manual", () => Option.isSome(prerequisite.metAt)),
    Match.orElse(() => Option.exists(Option.fromUndefinedOr(snapshot.commitments.get(prerequisite.ref)), (other) => other.state !== "open")),
  )

/** Where an open commitment stands: exactly one. */
export const standingOf = (snapshot: Snapshot, row: Commitment, facts: Facts): Standing => {
  if (Option.isNone(row.ownerLane)) return "unowned"
  if (row.ownerLane.value !== ROOT && facts.gone.has(row.ownerLane.value)) return "orphaned"
  if (Option.exists(row.reviewBy, (at) => facts.now > msOf(at))) return "overdue"
  if (Option.isNone(row.startedAt) && row.after.every(holds(snapshot, facts))) return "due"
  return "held"
}

const openRows = (snapshot: Snapshot): ReadonlyArray<Commitment> => [...snapshot.commitments.values()].filter((row) => row.state === "open")

/** The commits a read asks git about: every open commitment's claimed head and commit wait. */
export const asked = (snapshot: Snapshot): ReadonlyArray<string> =>
  Arr.dedupe(openRows(snapshot).flatMap((row) => [...Option.toArray(row.head), ...row.after.flatMap((each) => Arr.filter([each.ref], () => each.kind === "commit-on-main"))]))

/** The owners a read asks about. */
export const ownersOf = (snapshot: Snapshot): ReadonlyArray<string> => Arr.dedupe(openRows(snapshot).flatMap((row) => Option.toArray(Option.filter(row.ownerLane, (owner) => owner !== ROOT))))

export interface Check {
  readonly unowned: ReadonlyArray<string>
  readonly orphaned: ReadonlyArray<string>
  readonly overdue: ReadonlyArray<string>
  readonly due: ReadonlyArray<string>
  readonly held: ReadonlyArray<string>
  /** Hand-backs neither routed nor rejected, by id. */
  readonly unrouted: ReadonlyArray<number>
}

/** Every open commitment by standing, ids sorted. */
export const standingsOf = (snapshot: Snapshot, facts: Facts): ReadonlyMap<Standing, ReadonlyArray<Commitment>> => {
  const by = new Map<Standing, Array<Commitment>>(STANDINGS.map((standing) => [standing, []]))
  for (const row of Arr.sort(openRows(snapshot), Order.mapInput(Order.String, (each: Commitment) => each.id))) by.get(standingOf(snapshot, row, facts))?.push(row)
  return by
}

const idsIn = (by: ReadonlyMap<Standing, ReadonlyArray<Commitment>>, standing: Standing): ReadonlyArray<string> => (by.get(standing) ?? []).map((row) => row.id)

export const unroutedOf = (snapshot: Snapshot): ReadonlyArray<number> =>
  Arr.sort(
    [...snapshot.handBacks.values()].flatMap((each) => Arr.filter([each.id], () => each.routing === "unrouted")),
    Order.Number,
  )

export const checkOf = (snapshot: Snapshot, facts: Facts): Check => {
  const by = standingsOf(snapshot, facts)
  return { unowned: idsIn(by, "unowned"), orphaned: idsIn(by, "orphaned"), overdue: idsIn(by, "overdue"), due: idsIn(by, "due"), held: idsIn(by, "held"), unrouted: unroutedOf(snapshot) }
}

/** The owner of an open commitment as a checkpoint groups it: `-` for none. */
export const UNOWNED_KEY = "-"

export interface Checkpoint {
  /** Every open commitment, by owner (`-` for none), ids sorted. */
  readonly byOwner: ReadonlyMap<string, ReadonlyArray<string>>
  /** The ids the check lists (unowned, orphaned, overdue, due), sorted. */
  readonly listed: ReadonlyArray<string>
  readonly unrouted: ReadonlyArray<number>
}

export const checkpointOf = (snapshot: Snapshot, facts: Facts): Checkpoint => {
  const byOwner = new Map<string, Array<string>>()
  for (const row of Arr.sort(openRows(snapshot), Order.mapInput(Order.String, (each: Commitment) => each.id))) {
    const owner = Option.getOrElse(row.ownerLane, () => UNOWNED_KEY)
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), row.id])
  }
  const check = checkOf(snapshot, facts)
  return { byOwner, listed: Arr.sort([...check.unowned, ...check.orphaned, ...check.overdue, ...check.due], Order.String), unrouted: check.unrouted }
}

// ── The pass ──

/** Any command's events: `pass` here, with the facts it carries; every other in record.ts. */
export const decideCommand = (snapshot: Snapshot, command: Command, context: Context): Result.Result<ReadonlyArray<RecordEvent>, RecordRefused> =>
  Match.value(command).pipe(
    Match.tag("pass", (pass) => decidePass(snapshot, { now: context.now, onMain: new Set(pass.onMain), gone: new Set(pass.gone) }, pass.root, context)),
    Match.orElse((other) => decide(snapshot, other, context)),
  )

/** What one pass did: the commitments it landed, and the root it woke with the commitments newly due. */
export interface Passed {
  readonly landed: ReadonlyArray<string>
  readonly woke: Option.Option<{ readonly root: string; readonly ids: ReadonlyArray<string> }>
}

const landing = (snapshot: Snapshot, facts: Facts, context: Context): ReadonlyArray<RecordEvent> =>
  openRows(snapshot).flatMap((row) =>
    Option.toArray(Option.filter(row.head, (head) => facts.onMain.has(head))).map((head) => ({
      at: isoOf(context.now),
      run: row.run,
      subjectKind: "commitment" as const,
      subjectId: row.id,
      actor: context.actor,
      fromState: Option.some("open"),
      toState: Option.some("landed"),
      note: "",
      happening: Happening.cases.landed.make({ commit: head }),
    })),
  )

const waking = (snapshot: Snapshot, facts: Facts, context: Context, root: string): ReadonlyArray<RecordEvent> =>
  Arr.sort(openRows(snapshot), Order.mapInput(Order.String, (each: Commitment) => each.id))
    .filter((row) => Option.isNone(row.wokeAt) && standingOf(snapshot, row, facts) === "due")
    .map((row) => ({
      at: isoOf(context.now),
      run: row.run,
      subjectKind: "commitment" as const,
      subjectId: row.id,
      actor: context.actor,
      fromState: Option.some("open"),
      toState: Option.some("open"),
      note: "",
      happening: Happening.cases.woke.make({ root }),
    }))

/**
 * One pass: land each open commitment whose claimed head is on the default branch (as git says: no one says
 * `landed`), then, with a root to hear it, record `woke` for each commitment newly due and name it to that root. With
 * no root nothing is woken: the check keeps listing it as due until one exists.
 */
export const decidePass = (snapshot: Snapshot, facts: Facts, root: Option.Option<string>, context: Context): Result.Result<ReadonlyArray<RecordEvent>, RecordRefused> => {
  const landed = landing(snapshot, facts, context)
  const after = fold(snapshot, landed)
  const woke = Option.match(root, { onNone: (): ReadonlyArray<RecordEvent> => [], onSome: (each) => waking(after, facts, context, each) })
  return Result.succeed([...landed, ...woke])
}

/** What a pass's events did. */
export const passedOf = (events: ReadonlyArray<RecordEvent>): Passed => {
  const landed = events.flatMap((each) => Arr.filter([each.subjectId], () => each.happening._tag === "landed"))
  const woke = events.flatMap((each) => Option.toArray(Option.map(wokeRoot(each.happening), (root) => ({ root, id: each.subjectId }))))
  return { landed, woke: Option.map(Arr.head(woke), (first) => ({ root: first.root, ids: woke.map((each) => each.id) })) }
}

const wokeRoot = (happened: Happening): Option.Option<string> =>
  Match.value(happened).pipe(
    Match.tag("woke", (each) => Option.some(each.root)),
    Match.orElse(() => Option.none<string>()),
  )
