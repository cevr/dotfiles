// The reference model of the commitment record: the smallest thing that keeps the invariant. The acceptance test
// (record-model.sim.test.ts) drives a subject and this model with the same generated commands and compares what each
// answers. It is also the vocabulary of the seam (`Subject`): record-subject.ts maps these calls onto the real store
// (the SQLite file) and the plugin's handlers, with `World` standing in for git, the clock and the sessions.
// Reasons (r4): a follow-up, a deferral and a decision each carry a class and a pointer, checked against the record (a
// dependency's chain) and the world (the committed documents an invariant declares, the receipts the reader finds).
// Moved from the planner's acceptance/model.ts and rewritten within the effect-debt rules (Option for a missing root,
// owner or head; no class), its behaviour the same: a differential run compared the two on every observable.
import { Array as Arr, Match, Option, Order } from "effect"

/** When a commitment may start: every trigger of its list true. */
export type Trigger =
  | { readonly kind: "now" }
  | { readonly kind: "main"; readonly commit: string }
  | { readonly kind: "done"; readonly id: string }
  | { readonly kind: "at"; readonly ms: number }
  | { readonly kind: "manual"; readonly word: string }

/** What the plugin reads from outside the record: the clock, the default branch, who is alive, and the run's root. */
export interface World {
  now: number
  /** The commits on the default branch, in the order they landed. */
  readonly main: Set<string>
  /** The owners (lanes, units) that still exist; `root` always does. */
  readonly alive: Set<string>
  /** The run's root session; none while there is none (ended, replaced and not yet taken over). */
  root: Option.Option<string>
  /** The manual words the root has given. */
  readonly words: Set<string>
  /** The invariants' documents committed at HEAD, by invariant id: the blob each holds now (an edit commits a new one). */
  readonly documents: Map<string, string>
  /** The receipts the evidence reader finds under the checkout's evidence root, by path. */
  readonly receipts: Set<string>
}

/** Why a commitment is not done now, or why it was closed: a class and its canonical pointer (reasons.ts). */
export type ReasonClass = "guarantee" | "dependency" | "measured"
export interface Reason {
  readonly class: ReasonClass
  /** `invariant/<id>`, `commitment/<id>`, `receipt/<path>`, or a pointer of a kind not shipped (`spec-item/<id>`). */
  readonly ref: string
}
export type CloseKind = "guarantee" | "not-asked" | "placed" | "historical"

/** The flaws a mutant of the model has (record-subject.ts); none in the model itself. */
export interface Flaws {
  readonly acceptArbitraryReceipt?: boolean
  readonly acceptMeasuredClose?: boolean
  readonly clearHistoricReasonOnReopen?: boolean
  readonly acceptClosedDependency?: boolean
  /** An r3 mutant's own close (drops-reordered), which needs no reason. */
  readonly closeWithoutReason?: boolean
}

export type State = "open" | "landed" | "decided"
/** Where an open commitment stands; exactly one. `held` is fine, the other four are listed by the check. */
export type Standing = "unowned" | "orphaned" | "overdue" | "due" | "held"

export interface Check {
  readonly unowned: ReadonlyArray<string>
  readonly orphaned: ReadonlyArray<string>
  readonly overdue: ReadonlyArray<string>
  readonly due: ReadonlyArray<string>
  readonly held: ReadonlyArray<string>
  /** Hand-backs neither routed nor rejected. */
  readonly unrouted: ReadonlyArray<string>
}

export interface Checkpoint {
  /** Every open commitment, by owner (`-` for none), ids sorted. */
  readonly byOwner: ReadonlyMap<string, ReadonlyArray<string>>
  /** The ids the check lists (unowned, orphaned, overdue, due), sorted. */
  readonly listed: ReadonlyArray<string>
  readonly unrouted: ReadonlyArray<string>
}

export type HappenedType = "promised" | "assigned" | "ordered" | "released" | "claimed" | "landed" | "decided" | "deferred" | "reopened" | "woke"

export interface Happened {
  readonly type: HappenedType
  readonly by: string
  /** The reason the event carried (`<class> <ref>`), kept in the history after a reopen clears the row's. */
  readonly reason: Option.Option<string>
}

export type Answer<A> = { readonly ok: A } | { readonly refused: string }

export interface Woke {
  readonly woke: ReadonlyArray<{ readonly root: string; readonly ids: ReadonlyArray<string> }>
}

export interface Subject {
  /** An approval or a report with N parts makes N open, unowned commitments. */
  add(input: { readonly source: string; readonly fromOwner: boolean; readonly parts: ReadonlyArray<{ readonly id: string; readonly text: string }>; readonly by: string }): Answer<ReadonlyArray<string>>
  /** Give it an owner, a start condition and a review-by time; re-owning an owned one is the same call. */
  assign(input: { readonly id: string; readonly owner: string; readonly startOn: ReadonlyArray<Trigger>; readonly reviewBy: number; readonly by: string }): Answer<true>
  /** The root orders `owner` to start `ids`; answers every open commitment of that owner, started or not. */
  order(input: { readonly owner: string; readonly ids: ReadonlyArray<string>; readonly by: string }): Answer<ReadonlyArray<string>>
  /** Its owner gives it up: open and unowned again. */
  release(input: { readonly id: string; readonly by: string }): Answer<true>
  /**
   * A recorded decision closes it: the root's alone, with why and a guarantee on a declared invariant; a measurement or a
   * dependency never closes. A root that closes an owner-sourced one leaves a notice for the owner.
   */
  decide(input: { readonly id: string; readonly why: string; readonly by: string; readonly role: "root" | "worker"; readonly reason: Reason }): Answer<true>
  /** The root declares an invariant whose document is committed; the same again is nothing, an edited document refused (a new id). */
  declare(input: { readonly id: string; readonly by: string; readonly role: "root" | "worker" }): Answer<true>
  /**
   * A worker files a follow-up: unowned, open, with its reason (a dependency on an open commitment whose chain is open and
   * acyclic, or a receipt the reader finds); a retry with the same key and id files nothing again, the key on another id is
   * refused. Answers its id.
   */
  followUp(input: { readonly id: string; readonly key: string; readonly by: string; readonly reason: Reason }): Answer<string>
  /** The root keeps an open commitment open with why it waits; it closes nothing. */
  defer(input: { readonly id: string; readonly by: string; readonly reason: Reason }): Answer<true>
  /** Its current reason (`<class> <ref>`), none for none. */
  reason(id: string): Option.Option<string>
  /** How it was closed, none unless decided. */
  closeKind(id: string): Option.Option<CloseKind>
  /** Undo a decision: open and unowned again, its history kept. */
  reopen(input: { readonly id: string; readonly by: string }): Answer<true>
  /** The owner-sourced commitments a root closed by decision that the owner has not seen yet, sorted. */
  notices(): ReadonlyArray<string>
  /** The owner saw a notice. */
  seen(id: string): void
  /** A worker's hand-back: the commit it says carries each commitment it names. Unrouted until routed or rejected. */
  handBack(input: { readonly owner: string; readonly head: string; readonly ids: ReadonlyArray<string>; readonly by: string }): Answer<string>
  route(input: { readonly handBack: string; readonly as: "routed" | "rejected"; readonly by: string }): Answer<true>
  /** One pass of the plugin's own evaluation: land what is on the default branch, then wake the root once for each newly due commitment. */
  tick(): Woke
  check(): Check
  checkpoint(): Checkpoint
  state(id: string): Option.Option<State>
  history(id: string): ReadonlyArray<Happened>
  /** Every id ever promised. */
  ids(): ReadonlyArray<string>
}

interface Row {
  readonly id: string
  readonly fromOwner: boolean
  state: State
  owner: Option.Option<string>
  startOn: ReadonlyArray<Trigger>
  reviewBy: number
  started: boolean
  woken: boolean
  head: Option.Option<string>
  reason: Option.Option<Reason>
  closeKind: Option.Option<CloseKind>
  /** A follow-up's source: its session and idempotency key. */
  readonly key: Option.Option<string>
  readonly history: Array<Happened>
}

export const sorted = (ids: Iterable<string>): ReadonlyArray<string> => Arr.sort([...ids], Order.String)
export const refused = (why: string) => ({ refused: why })
/** An answer's value, when it was not refused. */
export const okOf = <A>(answer: Answer<A>): Option.Option<A> => {
  if ("ok" in answer) return Option.some(answer.ok)
  return Option.none()
}

const STANDINGS: ReadonlyArray<Standing> = ["unowned", "orphaned", "overdue", "due", "held"]

interface Held {
  readonly world: World
  readonly rows: Map<string, Row>
  readonly handBacks: Map<string, "unrouted" | "routed" | "rejected">
  readonly noticed: Set<string>
  readonly next: { handBack: number }
  /** The declared invariants: the blob each was declared at. */
  readonly invariants: Map<string, string>
  readonly flaws: Flaws
}

const rowOf = (held: Held, id: string): Option.Option<Row> => Option.fromUndefinedOr(held.rows.get(id))
const openRow = (held: Held, id: string): Option.Option<Row> => Option.filter(rowOf(held, id), (row) => row.state === "open")
const isOpen = (row: Row): boolean => row.state === "open"

const holds = (held: Held) => (trigger: Trigger): boolean =>
  Match.value(trigger).pipe(
    Match.when({ kind: "now" }, () => true),
    Match.when({ kind: "main" }, (main) => held.world.main.has(main.commit)),
    Match.when({ kind: "at" }, (at) => held.world.now >= at.ms),
    Match.when({ kind: "manual" }, (manual) => held.world.words.has(manual.word)),
    Match.when({ kind: "done" }, (done) => Option.exists(rowOf(held, done.id), (other) => other.state !== "open")),
    Match.exhaustive,
  )

const standingOf = (held: Held, row: Row): Standing => {
  if (Option.isNone(row.owner)) return "unowned"
  if (row.owner.value !== "root" && !held.world.alive.has(row.owner.value)) return "orphaned"
  if (held.world.now > row.reviewBy) return "overdue"
  if (!row.started && row.startOn.every(holds(held))) return "due"
  return "held"
}

const openIdsOf = (held: Held, owner: string): ReadonlyArray<string> =>
  sorted([...held.rows.values()].flatMap((row) => Arr.filter([row.id], () => isOpen(row) && Option.contains(row.owner, owner))))

/** The rows of `ids`, when each is an open commitment of `owner`. */
const ownedRows = (held: Held, owner: string, ids: ReadonlyArray<string>): Option.Option<ReadonlyArray<Row>> =>
  Option.all(ids.map((id) => Option.filter(openRow(held, id), (row) => Option.contains(row.owner, owner))))

const add = (held: Held) => (input: Parameters<Subject["add"]>[0]): Answer<ReadonlyArray<string>> => {
  if (input.parts.length === 0) return refused("no parts")
  if (input.source.trim() === "") return refused("no source")
  if (input.parts.some((part) => held.rows.has(part.id))) return refused("id taken")
  for (const part of input.parts)
    held.rows.set(part.id, {
      id: part.id,
      fromOwner: input.fromOwner,
      state: "open",
      owner: Option.none(),
      startOn: [],
      reviewBy: 0,
      started: false,
      woken: false,
      head: Option.none(),
      reason: Option.none(),
      closeKind: Option.none(),
      key: Option.none(),
      history: [{ type: "promised", by: input.by, reason: Option.none() }],
    })
  return { ok: input.parts.map((part) => part.id) }
}

const assign = (held: Held) => (input: Parameters<Subject["assign"]>[0]): Answer<true> => {
  const row = openRow(held, input.id)
  if (Option.isNone(row)) return refused("not open")
  if (input.startOn.length === 0) return refused("no start condition")
  if (input.reviewBy <= held.world.now) return refused("review-by is not ahead")
  Object.assign(row.value, { owner: Option.some(input.owner), startOn: input.startOn, reviewBy: input.reviewBy, started: false, woken: false })
  row.value.history.push({ type: "assigned", by: input.by, reason: Option.none() })
  return { ok: true }
}

const order = (held: Held) => (input: Parameters<Subject["order"]>[0]): Answer<ReadonlyArray<string>> => {
  const rows = ownedRows(held, input.owner, input.ids)
  if (Option.isNone(rows)) return refused("not an open commitment of that owner")
  for (const row of rows.value.filter((each) => !each.started)) {
    row.started = true
    row.history.push({ type: "ordered", by: input.by, reason: Option.none() })
  }
  return { ok: openIdsOf(held, input.owner) }
}

const release = (held: Held) => (input: Parameters<Subject["release"]>[0]): Answer<true> => {
  const row = Option.filter(openRow(held, input.id), (each) => Option.isSome(each.owner))
  if (Option.isNone(row)) return refused("not an owned open commitment")
  Object.assign(row.value, { owner: Option.none(), startOn: [], started: false, woken: false })
  row.value.history.push({ type: "released", by: input.by, reason: Option.none() })
  return { ok: true }
}

const decide = (held: Held) => (input: Parameters<Subject["decide"]>[0]): Answer<true> => {
  const row = openRow(held, input.id)
  if (Option.isNone(row)) return refused("not open")
  if (input.why.trim() === "") return refused("a decision says why")
  if (input.role !== "root") return refused("a close by decision is the root's")
  const closes = input.reason.class === "guarantee" || (held.flaws.acceptMeasuredClose === true && input.reason.class === "measured")
  if (held.flaws.closeWithoutReason !== true && (!closes || !holdsNow(held, Option.some(row.value.id), input.reason))) return refused("a close takes a guarantee that holds")
  Object.assign(row.value, { state: "decided", reason: Option.some(input.reason), closeKind: Option.some("guarantee") })
  row.value.history.push({ type: "decided", by: input.by, reason: Option.some(lineOf(input.reason)) })
  if (row.value.fromOwner) held.noticed.add(row.value.id)
  return { ok: true }
}

const reopen = (held: Held) => (input: Parameters<Subject["reopen"]>[0]): Answer<true> => {
  const row = Option.filter(rowOf(held, input.id), (each) => each.state === "decided")
  if (Option.isNone(row)) return refused("not a decided commitment")
  Object.assign(row.value, { state: "open", owner: Option.none(), startOn: [], started: false, woken: false, head: Option.none(), reason: Option.none(), closeKind: Option.none() })
  if (held.flaws.clearHistoricReasonOnReopen === true) row.value.history.splice(0, row.value.history.length, ...row.value.history.map((each) => ({ ...each, reason: Option.none<string>() })))
  row.value.history.push({ type: "reopened", by: input.by, reason: Option.none() })
  held.noticed.delete(row.value.id)
  return { ok: true }
}

// ── Reasons: what each class points at, checked against the record and the world ──

const lineOf = (reason: Reason): string => `${reason.class} ${reason.ref}`
/** A pointer's kind and its id or path. */
const partsOf = (ref: string): readonly [string, string] => [ref.slice(0, Math.max(0, ref.indexOf("/"))), ref.slice(ref.indexOf("/") + 1)]

/**
 * Whether `target` is a dependency `self` may wait on: an open commitment, not `self`, whose chain of dependencies on
 * commitments is open at every hop and never comes back to a commitment it passed.
 */
const dependencyHolds = (held: Held, self: Option.Option<string>, target: string): boolean => {
  const passed = new Set<string>(Option.toArray(self))
  const hop = { at: target }
  for (;;) {
    if (passed.has(hop.at)) return false
    const row = rowOf(held, hop.at)
    if (Option.isNone(row)) return false
    if (row.value.state !== "open" && held.flaws.acceptClosedDependency !== true) return false
    passed.add(hop.at)
    const next = Option.filter(row.value.reason, (reason) => reason.class === "dependency" && partsOf(reason.ref)[0] === "commitment")
    if (Option.isNone(next)) return true
    hop.at = partsOf(next.value.ref)[1]
  }
}

/** Whether `reason`, given to `self` (none for a new filing), points at something that holds now. */
const holdsNow = (held: Held, self: Option.Option<string>, reason: Reason): boolean => {
  const [kind, id] = partsOf(reason.ref)
  return Match.value(reason.class).pipe(
    Match.when("guarantee", () => kind === "invariant" && held.invariants.has(id)),
    Match.when("dependency", () => kind === "commitment" && dependencyHolds(held, self, id)),
    Match.when("measured", () => kind === "receipt" && (held.flaws.acceptArbitraryReceipt === true || held.world.receipts.has(id))),
    Match.exhaustive,
  )
}

const declare = (held: Held) => (input: Parameters<Subject["declare"]>[0]): Answer<true> => {
  if (input.role !== "root") return refused("declaring an invariant is the root's")
  const blob = Option.fromUndefinedOr(held.world.documents.get(input.id))
  if (Option.isNone(blob)) return refused("the document is not committed")
  const declared = Option.fromUndefinedOr(held.invariants.get(input.id))
  if (Option.isSome(declared)) return Option.match(Option.liftPredicate(declared.value, (at) => at === blob.value), { onSome: (): Answer<true> => ({ ok: true }), onNone: () => refused("declared already at another revision: a new id") })
  held.invariants.set(input.id, blob.value)
  return { ok: true }
}

const followUp = (held: Held) => (input: Parameters<Subject["followUp"]>[0]): Answer<string> => {
  const key = `${input.by}:${input.key}`
  const found = rowOf(held, input.id)
  if (Option.exists(found, (row) => Option.contains(row.key, key))) return { ok: input.id }
  if (Option.isSome(found)) return refused("the id is taken")
  if ([...held.rows.values()].some((row) => Option.contains(row.key, key))) return refused("the key filed another follow-up")
  if (input.reason.class === "guarantee" || !holdsNow(held, Option.none(), input.reason)) return refused("a follow-up names a dependency or a measurement that holds")
  held.rows.set(input.id, {
    id: input.id,
    fromOwner: false,
    state: "open",
    owner: Option.none(),
    startOn: [],
    reviewBy: 0,
    started: false,
    woken: false,
    head: Option.none(),
    reason: Option.some(input.reason),
    closeKind: Option.none(),
    key: Option.some(key),
    history: [{ type: "promised", by: input.by, reason: Option.some(lineOf(input.reason)) }],
  })
  return { ok: input.id }
}

const defer = (held: Held) => (input: Parameters<Subject["defer"]>[0]): Answer<true> => {
  const row = openRow(held, input.id)
  if (Option.isNone(row)) return refused("not open")
  if (!holdsNow(held, Option.some(row.value.id), input.reason)) return refused("its reason does not hold")
  row.value.reason = Option.some(input.reason)
  row.value.history.push({ type: "deferred", by: input.by, reason: Option.some(lineOf(input.reason)) })
  return { ok: true }
}

const handBack = (held: Held) => (input: Parameters<Subject["handBack"]>[0]): Answer<string> => {
  const rows = ownedRows(held, input.owner, input.ids)
  if (Option.isNone(rows)) return refused("not an open commitment of that owner")
  for (const row of rows.value) {
    row.head = Option.some(input.head)
    row.history.push({ type: "claimed", by: input.by, reason: Option.none() })
  }
  const id = `h${held.next.handBack}`
  held.next.handBack += 1
  held.handBacks.set(id, "unrouted")
  return { ok: id }
}

const route = (held: Held) => (input: Parameters<Subject["route"]>[0]): Answer<true> => {
  if (held.handBacks.get(input.handBack) !== "unrouted") return refused("not an unrouted hand-back")
  held.handBacks.set(input.handBack, input.as)
  return { ok: true }
}

const tick = (held: Held) => (): Woke => {
  for (const row of held.rows.values()) {
    if (!isOpen(row) || !Option.exists(row.head, (head) => held.world.main.has(head))) continue
    row.state = "landed"
    row.history.push({ type: "landed", by: "plugin", reason: Option.none() })
  }
  return Option.match(held.world.root, {
    onNone: (): Woke => ({ woke: [] }),
    onSome: (root): Woke => {
      const due = [...held.rows.values()].filter((row) => isOpen(row) && !row.woken && standingOf(held, row) === "due")
      for (const row of due) {
        row.woken = true
        row.history.push({ type: "woke", by: "plugin", reason: Option.none() })
      }
      return { woke: Arr.match(due, { onEmpty: () => [], onNonEmpty: (each) => [{ root, ids: sorted(each.map((row) => row.id)) }] }) }
    },
  })
}

const unroutedOf = (held: Held): ReadonlyArray<string> => sorted([...held.handBacks].flatMap(([id, state]) => Arr.filter([id], () => state === "unrouted")))

const check = (held: Held) => (): Check => {
  const of = (standing: Standing) => sorted([...held.rows.values()].flatMap((row) => Arr.filter([row.id], () => isOpen(row) && standingOf(held, row) === standing)))
  return { unowned: of("unowned"), orphaned: of("orphaned"), overdue: of("overdue"), due: of("due"), held: of("held"), unrouted: unroutedOf(held) }
}

const checkpoint = (held: Held) => (): Checkpoint => {
  const byOwner = new Map<string, ReadonlyArray<string>>()
  for (const row of held.rows.values()) {
    if (!isOpen(row)) continue
    const owner = Option.getOrElse(row.owner, () => "-")
    byOwner.set(owner, sorted([...(byOwner.get(owner) ?? []), row.id]))
  }
  const now = check(held)()
  return { byOwner, listed: sorted(STANDINGS.filter((each) => each !== "held").flatMap((each) => now[each])), unrouted: now.unrouted }
}

/** The reference model over `world`; a mutant passes its `flaws`. */
export const makeModel = (world: World, flaws: Flaws = {}): Subject => {
  const held: Held = { world, rows: new Map(), handBacks: new Map(), noticed: new Set(), next: { handBack: 1 }, invariants: new Map(), flaws }
  return {
    add: add(held),
    assign: assign(held),
    order: order(held),
    release: release(held),
    decide: decide(held),
    reopen: reopen(held),
    declare: declare(held),
    followUp: followUp(held),
    defer: defer(held),
    reason: (id) => Option.flatMap(rowOf(held, id), (row) => Option.map(row.reason, lineOf)),
    closeKind: (id) => Option.flatMap(rowOf(held, id), (row) => row.closeKind),
    notices: () => sorted(held.noticed),
    seen: (id) => void held.noticed.delete(id),
    handBack: handBack(held),
    route: route(held),
    tick: tick(held),
    check: check(held),
    checkpoint: checkpoint(held),
    state: (id) => Option.map(rowOf(held, id), (row) => row.state),
    history: (id) => Option.match(rowOf(held, id), { onNone: () => [], onSome: (row) => [...row.history] }),
    ids: () => sorted(held.rows.keys()),
  }
}
