// The acceptance check of the commitment record, model-based: seeded sequences of approvals with N parts, reports'
// follow-ups, assignments, re-owning, orders to an owner, hand-backs with and without a root, restarts, compactions
// (the checkpoint read), triggers turning true (a commit on the default branch, another commitment closing, a date, the
// root's word), lanes ending, decisions and reopenings, follow-ups, deferrals and invariants with their reasons (a
// dependency held, closed or a ghost, a receipt found or lost, a document committed, edited or never there, a kind not
// shipped), against the reference model (record-model.ts) and against the
// test's own bookkeeping of the invariant:
//
//   Every open commitment is at all times in exactly one standing: held (owned by a living owner, with a start
//   condition not yet true or work started, and a review-by time ahead), or listed by the check (unowned, orphaned,
//   overdue, due). None leaves `open` except by a commit on the default branch that a hand-back claimed for it, or by
//   a recorded decision with its reason; re-owning keeps it open. A restart and a compaction change nothing. A
//   commitment that becomes due wakes the root once per assignment. A hand-back is listed until routed or rejected.
//
// Run: bun test cmd/orchestrate/record-model.sim.test.ts                  (the built record: SQLite on a scratch file)
//      SUBJECT=model bun test …         (the test checking itself: green)
//      SUBJECT=wakes-twice bun test …   (a mutant: red; record-subject.ts names the nine)
//      SIM_SEED=<n> replays one seed.
// Moved from the planner's acceptance/record-model.test.ts: the generator rewritten within the effect-debt rules on the
// seed runner's generator, the assertions the same.
import { expect } from "bun:test"
import { Array as Arr, Config, Effect, Layer, Match, Option, type Random } from "effect"
import { below, generator } from "../../sim/runtime.ts"
import * as Seed from "../../sim/seed.ts"
import { RECORD_CASES } from "../../sim/witness-cases.ts"
import { assertEffectWitness, witnesses } from "../../sim/witnesses.ts"
import { platform as ownPlatform } from "@dotfiles/opencode-orchestrate/node/platform"
import { hostServices } from "../../sim/host-services.ts"
import * as SqliteRecord from "@dotfiles/opencode-orchestrate/sqlite/record"
import { scratch } from "../../tests/scratch.ts"
import { type Answer, type Happened, makeModel, okOf, type Reason, type State, type Subject, type Trigger, type World } from "./record-model.ts"
import { type Opened, SUBJECTS } from "./record-subject.ts"

const FILE = "cmd/orchestrate/record-model.sim.test.ts"
const { seeded } = Seed.runner(FILE)

const STEPS = 120
const OWNERS: Arr.NonEmptyReadonlyArray<string> = ["L1", "L2", "L3", "root"]
const LANES: Arr.NonEmptyReadonlyArray<string> = ["L1", "L2", "L3"]
const WORDS: Arr.NonEmptyReadonlyArray<string> = ["w1", "w2"]
const INVARIANTS: Arr.NonEmptyReadonlyArray<string> = ["i1", "i2", "i3"]
const DAY = 86_400_000

/** `SUBJECT`: the subject the run drives; the built record when unset. */
const subjectName = Effect.gen(function* () {
  return Option.getOrElse(yield* Config.option(Config.String("SUBJECT")), () => "")
})

/** The test's own bookkeeping, apart from the model. */
interface Books {
  readonly promised: Array<string>
  readonly claimed: Map<string, string>
  readonly decided: Set<string>
  readonly epoch: Map<string, number>
  readonly woken: Set<string>
  readonly commits: Array<string>
  readonly handBacks: Array<string>
  /** Every receipt path made, found or lost since; every follow-up key used. */
  readonly receipts: Array<string>
  readonly keys: Array<string>
  readonly counts: { roots: number; minted: number; step: number }
}

interface Run {
  readonly world: World
  readonly random: Random.Random
  readonly expect: Seed.Seeded["expect"]
  readonly opened: Opened
  readonly held: { subject: Subject }
  readonly reference: Subject
  readonly books: Books
}

const next = (run: Run) => run.random.nextDoubleUnsafe()
const pick = <A>(run: Run, from: Arr.NonEmptyReadonlyArray<A>): A => Option.getOrElse(Arr.get(from, below(run.random, from.length)), () => Arr.headNonEmpty(from))
/** `body` on one of `from`, none when it is empty. */
const withPick = <A>(run: Run, from: ReadonlyArray<A>, body: (one: A) => void) => {
  if (Arr.isReadonlyArrayNonEmpty(from)) body(pick(run, from))
}
const subjectOf = (run: Run) => run.held.subject
const bump = (run: Run, id: string) => run.books.epoch.set(id, (run.books.epoch.get(id) ?? 0) + 1)
const isOpen = (run: Run, id: string) => Option.contains(subjectOf(run).state(id), "open")
const openIds = (run: Run) => run.books.promised.filter((id) => isOpen(run, id))
const ownOf = (run: Run, owner: string) => run.reference.checkpoint().byOwner.get(owner) ?? []
const mint = (run: Run) => {
  const commit = `s${run.books.commits.length + 1}`
  run.books.commits.push(commit)
  return commit
}

/** Both refused, or both answered the same; the words of a refusal are the implementation's own. */
const same = <A>(run: Run, got: Answer<A>, want: Answer<A>, what: string) => {
  run.expect({ what, refused: "refused" in got }).toEqual({ what, refused: "refused" in want })
  run.expect({ what, ok: okOf(got) }).toEqual({ what, ok: okOf(want) })
}

const trigger = (run: Run): Trigger => {
  const kind = pick(run, ["now", "now", "main", "done", "at", "manual"] as const)
  if (kind === "main") return { kind, commit: mint(run) }
  if (kind === "done" && Arr.isReadonlyArrayNonEmpty(run.books.promised)) return { kind, id: pick(run, run.books.promised) }
  if (kind === "at") return { kind, ms: run.world.now + Math.floor(next(run) * 3 * DAY) }
  if (kind === "manual") return { kind, word: pick(run, WORDS) }
  return { kind: "now" }
}

/** An approval with N parts, or a report's follow-ups. */
const add = (run: Run) => {
  const parts = Arr.makeBy(1 + below(run.random, 4), () => ({ id: `c${++run.books.counts.minted}`, text: "a part" }))
  const source = pick(run, ["question:root-1:q7", "report:u1/round-1-findings", "plan:p1"])
  const input = { source, fromOwner: next(run) < 0.5, parts, by: Option.getOrElse(run.world.root, () => "worker-1") }
  const got = subjectOf(run).add(input)
  same(run, got, run.reference.add(input), "add")
  if ("ok" in got) for (const part of parts) run.books.promised.push(part.id)
}

const assign = (run: Run) =>
  withPick(run, openIds(run), (id) => {
    const startOn = Arr.makeBy(1 + below(run.random, 2), () => trigger(run))
    const input = { id, owner: pick(run, OWNERS), startOn, reviewBy: run.world.now + Math.floor((0.5 + next(run) * 6) * DAY), by: "root-1" }
    const got = subjectOf(run).assign(input)
    same(run, got, run.reference.assign(input), "assign")
    if ("ok" in got) bump(run, id)
  })

/** A new order to an owner: it must answer every open commitment of that owner. */
const order = (run: Run) => {
  const owner = pick(run, OWNERS)
  const own = ownOf(run, owner)
  const input = { owner, ids: own.filter(() => next(run) < 0.4), by: "root-1" }
  const got = subjectOf(run).order(input)
  same(run, got, run.reference.order(input), "order")
  const what = "an order shows the owner's open commitments"
  run.expect({ what, shown: okOf(got) }).toEqual({ what, shown: Option.some(own) })
}

const release = (run: Run) =>
  withPick(run, openIds(run), (id) => {
    const input = { id, by: "root-1" }
    const got = subjectOf(run).release(input)
    same(run, got, run.reference.release(input), "release")
    if ("ok" in got) bump(run, id)
  })

/** One of `from` with probability `p` (never when `from` is empty), else `otherwise`. */
const maybePick = (run: Run, from: ReadonlyArray<string>, p: number, otherwise: () => string): string => {
  if (Arr.isReadonlyArrayNonEmpty(from) && next(run) < p) return pick(run, from)
  return otherwise()
}

/** A reason as a caller gives one: of every class and kind, its target held, closed, lost, stale or never there. */
const reasonOf = (run: Run): Reason => {
  const kind = pick(run, ["guarantee", "guarantee", "dependency", "dependency", "measured", "unshipped"] as const)
  if (kind === "guarantee") return { class: "guarantee", ref: `invariant/${pick(run, INVARIANTS)}` }
  if (kind === "unshipped") return { class: pick(run, ["guarantee", "dependency"] as const), ref: pick(run, ["spec-item/s1", "unit/u1", "owner-question/q1"] as const) }
  // Mostly an open commitment (a dependency that may hold), else any promised one (perhaps closed) or a ghost.
  const open = openIds(run)
  if (kind === "dependency") return { class: "dependency", ref: `commitment/${maybePick(run, open, 0.7, () => maybePick(run, run.books.promised, 0.8, () => "ghost"))}` }
  return { class: "measured", ref: `receipt/${maybePick(run, run.books.receipts, 0.8, () => "tmp/orchestrate/r1/never.json")}` }
}

const whyOf = (run: Run) => {
  if (next(run) < 0.15) return " "
  return "superseded"
}

const decide = (run: Run) =>
  withPick(run, run.books.promised, (id) => {
    const input = { id, why: whyOf(run), by: "someone", role: pick(run, ["root", "root", "worker"] as const), reason: reasonOf(run) }
    const got = subjectOf(run).decide(input)
    same(run, got, run.reference.decide(input), "decide")
    if (!("ok" in got)) return
    run.books.decided.add(id)
  })

/** The root (or, refused, a worker) declares an invariant: committed or not, at the revision it was declared or edited since. */
const declare = (run: Run) => {
  const input = { id: pick(run, INVARIANTS), by: "root-1", role: pick(run, ["root", "root", "root", "worker"] as const) }
  same(run, subjectOf(run).declare(input), run.reference.declare(input), "declare")
}

/** The id a follow-up by `key` names: `f-<key>`, or on a retry sometimes (refused) another. */
const filedId = (run: Run, key: string, retry: boolean): string => {
  if (!retry || next(run) < 0.6) return `f-${key}`
  return `f${++run.books.counts.minted}`
}

/** A worker files a follow-up: a new finding, a retry of its last (same key, same id), or its key on another id. */
const followUp = (run: Run) => {
  const fresh = `k${run.books.keys.length + 1}`
  const key = maybePick(run, run.books.keys, 0.25, () => fresh)
  const retry = key !== fresh
  // A key files `f-<key>`: a retry names it again, or (refused) names another id.
  const id = filedId(run, key, retry)
  const input = { id, key, by: "worker-1", reason: reasonOf(run) }
  const got = subjectOf(run).followUp(input)
  same(run, got, run.reference.followUp(input), "followUp")
  if (!retry) run.books.keys.push(key)
  if (!("ok" in got) || run.books.promised.includes(input.id)) return
  run.books.promised.push(input.id)
}

/** The root keeps an open (or, refused, a closed) commitment waiting on a reason. */
const defer = (run: Run) =>
  withPick(run, run.books.promised, (id) => {
    const input = { id, by: "root-1", reason: reasonOf(run) }
    const got = subjectOf(run).defer(input)
    same(run, got, run.reference.defer(input), "defer")
  })

// The world's evidence moves: an invariant's document committed or edited, a receipt written or lost.
const commitDocument = (run: Run) => void run.world.documents.set(pick(run, INVARIANTS), (++run.books.counts.minted).toString(16).padStart(40, "0"))
const receiptMade = (run: Run) => {
  const path = `tmp/orchestrate/r1/r${run.books.receipts.length + 1}.json`
  run.books.receipts.push(path)
  run.world.receipts.add(path)
}
const receiptLost = (run: Run) => withPick(run, [...run.world.receipts], (path) => void run.world.receipts.delete(path))

const reopen = (run: Run) =>
  withPick(run, [...run.books.decided], (id) => {
    const input = { id, by: "root-1" }
    const got = subjectOf(run).reopen(input)
    same(run, got, run.reference.reopen(input), "reopen")
    if (!("ok" in got)) return
    run.books.decided.delete(id)
    run.books.claimed.delete(id)
    bump(run, id)
  })

/** A hand-back, whether or not a root is there to hear it. */
const handBack = (run: Run) => {
  const owner = pick(run, OWNERS)
  const own = ownOf(run, owner)
  const commit = mint(run)
  const input = { owner, head: commit, ids: own.filter(() => next(run) < 0.5), by: `worker-${owner}` }
  const got = subjectOf(run).handBack(input)
  const want = run.reference.handBack(input)
  run.expect({ what: "handBack", refused: "refused" in got }).toEqual({ what: "handBack", refused: "refused" in want })
  run.expect(okOf(got)).toEqual(okOf(want))
  Option.map(okOf(got), (name) => {
    run.books.handBacks.push(name)
    for (const id of input.ids) run.books.claimed.set(id, commit)
  })
}

const route = (run: Run) =>
  withPick(run, run.books.handBacks, (name) => {
    const input = { handBack: name, as: pick(run, ["routed", "rejected"] as const), by: "root-1" }
    same(run, subjectOf(run).route(input), run.reference.route(input), "route")
  })

// The world moves: a commit lands, time passes, the root gives its word, a lane ends, the root ends or is replaced.
const land = (run: Run) =>
  withPick(
    run,
    run.books.commits.filter((commit) => !run.world.main.has(commit)),
    (commit) => void run.world.main.add(commit),
  )
const pass = (run: Run) => {
  run.world.now += Math.floor(next(run) * 2 * DAY)
}
const word = (run: Run) => void run.world.words.add(pick(run, WORDS))
const laneEnds = (run: Run) => void run.world.alive.delete(pick(run, LANES))
const newRoot = (run: Run) => Option.some(`root-${++run.books.counts.roots}`)
const rootMoves = (run: Run) => {
  if (Option.isSome(run.world.root) && next(run) < 0.5) run.world.root = Option.none()
  else run.world.root = newRoot(run)
}

/** Each commitment's reason, close kind and history (with each event's reason), by id. */
const reasonsOf = (subject: Subject) => subject.ids().map((id) => ({ id, reason: subject.reason(id), closeKind: subject.closeKind(id), history: subject.history(id) }))

const observed = (subject: Subject) => ({ check: subject.check(), checkpoint: subject.checkpoint(), notices: subject.notices(), reasons: reasonsOf(subject) })

/** A server or kernel restart: nothing carried in memory. */
const restart = (run: Run) => {
  const before = observed(subjectOf(run))
  run.held.subject = run.opened.reopen()
  const what = "a restart changes nothing"
  run.expect({ what, ...observed(subjectOf(run)) }).toEqual({ what, ...before })
}

const seen = (run: Run) =>
  withPick(run, subjectOf(run).notices(), (id) => {
    subjectOf(run).seen(id)
    run.reference.seen(id)
  })

const COMMANDS: Arr.NonEmptyReadonlyArray<readonly [number, (run: Run) => void]> = [
  [14, add],
  [16, assign],
  [10, order],
  [5, release],
  [7, decide],
  [3, reopen],
  [10, handBack],
  [6, route],
  [10, land],
  [8, pass],
  [3, word],
  [3, laneEnds],
  [4, rootMoves],
  [6, restart],
  [3, seen],
  [4, declare],
  [6, followUp],
  [5, defer],
  [2, commitDocument],
  [3, receiptMade],
  [1, receiptLost],
]
const TOTAL = COMMANDS.reduce((sum, [weight]) => sum + weight, 0)

const commandOf = (run: Run) => {
  const at = { left: next(run) * TOTAL }
  return Option.getOrElse(
    Arr.findFirst(COMMANDS, ([weight]) => {
      at.left -= weight
      return at.left < 0
    }),
    () => Arr.headNonEmpty(COMMANDS),
  )[1]
}

/** The plugin's own pass: each wake goes to the run's root, and a commitment wakes it once per assignment. */
const ticked = (run: Run) => {
  const step = run.books.counts.step
  const woke = subjectOf(run).tick()
  run.expect({ step, what: "tick", woke: woke.woke }).toEqual({ step, what: "tick", woke: run.reference.tick().woke })
  for (const wake of woke.woke) {
    const toRoot = "a wake goes to the run's root"
    run.expect({ step, what: toRoot, root: Option.some(wake.root) }).toEqual({ step, what: toRoot, root: run.world.root })
    for (const id of wake.ids) {
      const key = `${id}@${run.books.epoch.get(id) ?? 0}`
      const once = "a commitment wakes the root once per assignment"
      run.expect({ step, what: once, key, again: run.books.woken.has(key) }).toEqual({ step, what: once, key, again: false })
      run.books.woken.add(key)
    }
  }
}

const lastDecision = (types: ReadonlyArray<Happened["type"]>) => Arr.last(types.filter((type) => type !== "woke"))

/** Why `id`'s state breaks the invariant by the test's own books; empty when it does not. */
const wrongOf = (run: Run, id: string, state: Option.Option<State>, types: ReadonlyArray<Happened["type"]>): string => {
  if (Option.contains(state, "landed")) {
    const commit = Option.fromUndefinedOr(run.books.claimed.get(id))
    if (Option.exists(commit, (each) => run.world.main.has(each)) && types.includes("landed")) return ""
    return "landed with no claimed commit on the default branch"
  }
  if (Option.contains(state, "decided")) {
    if (run.books.decided.has(id) && Option.contains(lastDecision(types), "decided")) return ""
    return "decided with no recorded decision"
  }
  if (Option.contains(state, "open")) {
    if (run.books.decided.has(id)) return "open after a decision that was not reopened"
    return ""
  }
  return "no state"
}

/** The same answers as the model, and the invariant from the test's own books. */
const compared = (run: Run) => {
  const step = run.books.counts.step
  const subject = subjectOf(run)
  const check = subject.check()
  run.expect({ step, check }).toEqual({ step, check: run.reference.check() })
  run.expect({ step, checkpoint: subject.checkpoint() }).toEqual({ step, checkpoint: run.reference.checkpoint() })
  run.expect({ step, notices: subject.notices() }).toEqual({ step, notices: run.reference.notices() })
  // Every reason, close kind and history the same, each event's reason kept after a reopen clears the row's.
  run.expect({ step, reasons: reasonsOf(subject) }).toEqual({ step, reasons: reasonsOf(run.reference) })
  const kept = "nothing promised disappears"
  run.expect({ step, what: kept, ids: subject.ids() }).toEqual({ step, what: kept, ids: [...run.books.promised].sort() })
  const one = "each open commitment has exactly one standing"
  const listed = [...check.unowned, ...check.orphaned, ...check.overdue, ...check.due, ...check.held].sort()
  run.expect({ step, what: one, listed }).toEqual({ step, what: one, listed: openIds(run).sort() })
  for (const id of run.books.promised) {
    const state = subject.state(id)
    const types = subject.history(id).map((each) => each.type)
    run.expect({ step, id, state, why: wrongOf(run, id, state, types) }).toEqual({ step, id, state, why: "" })
    const first = "its history starts at its promise"
    run.expect({ step, id, what: first, first: Arr.head(types) }).toEqual({ step, id, what: first, first: Option.some("promised") })
  }
}

const startRun = (seed: number, expect: Seed.Seeded["expect"], open: (world: World) => Opened): Run => {
  const world = freshWorld()
  const opened = open(world)
  const books: Books = { promised: [], claimed: new Map(), decided: new Set(), epoch: new Map(), woken: new Set(), commits: [], handBacks: [], receipts: [], keys: [], counts: { roots: 1, minted: 0, step: 0 } }
  const run: Run = { world, random: generator(seed), expect, opened, held: { subject: opened.subject }, reference: makeModel(world), books }
  // The root declares the invariant whose document the world starts with, so a guarantee can hold from the first step.
  same(run, opened.subject.declare({ id: "i1", by: "root-1", role: "root" }), run.reference.declare({ id: "i1", by: "root-1", role: "root" }), "declare i1")
  return run
}

const runSeed = (seed: number, expect: Seed.Seeded["expect"], open: (world: World) => Opened) => {
  const run = startRun(seed, expect, open)
  const { books } = run
  for (books.counts.step = 0; books.counts.step < STEPS; books.counts.step += 1) {
    commandOf(run)(run)
    ticked(run)
    compared(run)
  }
  run.opened.close()
}

/** A deliberate walk, through the same model and invariants as the seeded walk. */
type OmitWitness = "six promises" | "follow-up" | "deferral" | "decision" | "none"
const coverPromises = (open: (world: World) => Opened, without: OmitWitness) => {
  const run = startRun(1, expect, open)
  const parts = Arr.makeBy(6, (index) => ({ id: `w${index}`, text: `witness ${index}` }))
  const promised = parts.filter((_, index) => without !== "six promises" || index < 5)
  const add = { source: "plan:p1", fromOwner: true, parts: promised, by: "root-1" }
  const subject = subjectOf(run)
  const added = subject.add(add)
  same(run, added, run.reference.add(add), "six explicit promises")
  expect("ok" in added).toBe(true)
  run.books.promised.push(...promised.map((part) => part.id))
  compared(run)
  const reason = { class: "guarantee", ref: "invariant/i1" } as const
  const followUp = { id: "w-follow", key: "w-follow", by: "worker-1", reason: { class: "dependency", ref: "commitment/w0" } } as const
  const defer = { id: "w0", by: "root-1", reason }
  const decide = { id: "w1", why: "superseded", by: "root-1", role: "root", reason } as const
  for (const [kind, [call, record]] of witnesses(["follow-up", "deferral", "decision"] as const, {
    "follow-up": [(one: Subject) => one.followUp(followUp), () => run.books.promised.push(followUp.id)],
    deferral: [(one: Subject) => one.defer(defer), () => {}],
    decision: [(one: Subject) => one.decide(decide), () => run.books.decided.add(decide.id)],
  })) {
    if (kind === without) continue
    const answer = call(subject)
    same<string | true>(run, answer, call(run.reference), kind)
    expect({ kind, took: "ok" in answer }).toEqual({ kind, took: true })
    record()
    ticked(run)
    compared(run)
  }
  restart(run)
  compared(run)
  const live = subjectOf(run)
  const seen = (id: string) => ({ state: live.state(id), last: live.history(id).at(-1)?.type, reason: live.reason(id) })
  const evidence = {
    promises: parts.filter((part) => live.history(part.id)[0]?.type === "promised").map((part) => part.id),
    followUp: seen(followUp.id),
    deferral: seen(defer.id),
    decision: seen(decide.id),
  }
  run.opened.close()
  return evidence
}

// ── The reasons' cross product: caller × operation × state × reason class × pointer kind × existence ──

const CALLERS = ["root", "worker"] as const
const OPERATIONS = ["followUp", "defer", "decide"] as const
const STATES = ["open", "decided", "absent"] as const
const CLASSES = ["guarantee", "dependency", "measured"] as const
const KINDS = ["invariant", "commitment", "receipt", "spec-item", "unit", "owner-question"] as const
/** held: the thing exists and holds now; missing: never there; stale: there once (a dependency closed, a receipt lost, a document edited since its declaration). */
const EXISTENCE = ["held", "missing", "stale"] as const
type Case = readonly [(typeof CALLERS)[number], (typeof OPERATIONS)[number], (typeof STATES)[number], (typeof CLASSES)[number], (typeof KINDS)[number], (typeof EXISTENCE)[number]]

const RECEIPT = { held: "tmp/orchestrate/r1/held.json", missing: "tmp/orchestrate/r1/never.json", stale: "tmp/orchestrate/r1/lost.json" } as const
const INVARIANT = { held: "i1", missing: "ghost", stale: "i2" } as const

/**
 * Each case on its own ids in one record: the subject and the reference answer the same, and the case's commitment has
 * the same state, reason, close kind and history after it, after every case's decided one is reopened, and after a
 * restart. Answers how many of each operation each side took and refused (the enumeration reaches both).
 */
/** Why an answer refused, "" when it took. */
const refusalOf = <A>(answer: Answer<A>): string => {
  if ("refused" in answer) return answer.refused
  return ""
}

const crossProduct = (opened: Opened, world: World): Map<string, number> => {
  const model = makeModel(world)
  const held = { subject: opened.subject }
  const both = <A>(call: (subject: Subject) => Answer<A>, what: string): Answer<A> => {
    const [got, want] = [call(held.subject), call(model)]
    expect({ what, ok: okOf(got), refused: "refused" in got, why: refusalOf(got) }).toEqual({ what, ok: okOf(want), refused: "refused" in want, why: expect.any(String) })
    return got
  }
  const byRoot = { by: "root-1", role: "root" as const }
  const holds = { class: "guarantee" as const, ref: `invariant/${INVARIANT.held}` }
  // The world before the cases: two documents committed and declared, one edited since; a receipt found, one lost.
  for (const [n, id] of [INVARIANT.held, INVARIANT.stale].entries()) world.documents.set(id, String(n + 1).repeat(40))
  for (const id of [INVARIANT.held, INVARIANT.stale]) both((subject) => subject.declare({ id, ...byRoot }), `declare ${id}`)
  world.documents.set(INVARIANT.stale, "e".repeat(40))
  world.receipts.add(RECEIPT.held)
  const counts = new Map<string, number>()
  const cases: ReadonlyArray<Case> = CALLERS.flatMap((caller) =>
    OPERATIONS.flatMap((operation) => STATES.flatMap((state) => CLASSES.flatMap((klass) => KINDS.flatMap((kind) => EXISTENCE.map((existence): Case => [caller, operation, state, klass, kind, existence]))))),
  )
  cases.forEach(([caller, operation, state, klass, kind, existence], n) => {
    const what = `${caller} ${operation} on ${state}, ${klass} ${kind} ${existence}`
    const [target, dependency] = [`t${n}`, `d${n}`]
    const add = (id: string) => both((subject) => subject.add({ source: "plan:p1", fromOwner: n % 2 === 0, parts: [{ id, text: "a part" }], by: "root-1" }), `${what}: add ${id}`)
    add(dependency)
    if (kind === "commitment" && existence === "stale") both((subject) => subject.decide({ id: dependency, why: "done", ...byRoot, reason: holds }), `${what}: close ${dependency}`)
    if (state !== "absent") add(target)
    if (state === "decided") both((subject) => subject.decide({ id: target, why: "done", ...byRoot, reason: holds }), `${what}: close ${target}`)
    if (kind === "receipt" && existence === "stale") {
      world.receipts.add(RECEIPT.stale)
      world.receipts.delete(RECEIPT.stale)
    }
    const ref = Match.value(kind).pipe(
      Match.when("invariant", () => `invariant/${INVARIANT[existence]}`),
      Match.when("commitment", () => `commitment/${Match.value(existence).pipe(Match.when("missing", () => "ghost"), Match.orElse(() => dependency))}`),
      Match.when("receipt", () => `receipt/${RECEIPT[existence]}`),
      Match.orElse(() => `${kind}/x1`),
    )
    const reason: Reason = { class: klass, ref }
    const got = Match.value(operation).pipe(
      Match.when("followUp", () => okOf(both((subject) => subject.followUp({ id: Match.value(state).pipe(Match.when("absent", () => `f${n}`), Match.orElse(() => target)), key: `k${n}`, by: "worker-1", reason }), what))),
      Match.when("defer", () => okOf(both((subject) => subject.defer({ id: target, by: "root-1", reason }), what))),
      Match.when("decide", () => okOf(both((subject) => subject.decide({ id: target, why: "a reason", by: `${caller}-1`, role: caller, reason }), what))),
      Match.exhaustive,
    )
    const key = `${operation} ${Option.match(got, { onSome: () => "took", onNone: () => "refused" })}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
    const mine = (subject: Subject) => [target, dependency, `f${n}`].map((id) => ({ id, state: subject.state(id), reason: subject.reason(id), closeKind: subject.closeKind(id), history: subject.history(id) }))
    expect({ what, after: mine(held.subject) }).toEqual({ what, after: mine(model) })
  })
  // A reopen clears each decided row's reason and keeps the history's; a restart replays the same rows.
  for (const id of held.subject.ids().filter((id) => Option.contains(held.subject.state(id), "decided"))) both((subject) => subject.reopen({ id, by: "root-1" }), `reopen ${id}`)
  expect(reasonsOf(held.subject)).toEqual(reasonsOf(model))
  held.subject = opened.reopen()
  expect(reasonsOf(held.subject)).toEqual(reasonsOf(model))
  opened.close()
  return counts
}

/** `body` on the `SUBJECT` subject over a fresh scratch file, made and migrated as the plugin's start makes it; the built subject attaches to it, a restart attaches again. */
const onSubject = <A>(body: (open: (world: World) => Opened) => A) =>
  Effect.gen(function* () {
    const name = yield* subjectName
    const make = yield* Effect.fromOption(Option.fromUndefinedOr(SUBJECTS.get(name))).pipe(
      Effect.mapError(() => new Seed.SeedFailed({ message: `SUBJECT=${name}: not a subject; record-subject.ts names them` })),
    )
    return yield* Effect.acquireUseRelease(
      Effect.tap(Effect.sync(() => scratch("record-model-")), (dir) => Effect.scoped(SqliteRecord.open(`${dir.path}/record.db`, { readonly: false, now: 1_000_000 })).pipe(Effect.orDie)),
      (dir) => Effect.sync(() => body((world) => make(`${dir.path}/record.db`, world))),
      (dir) => Effect.sync(() => dir[Symbol.dispose]()),
    )
  }).pipe(Effect.provide(Layer.mergeAll(hostServices, ownPlatform)))

const freshWorld = (): World => ({ now: 1_000_000, main: new Set(), alive: new Set(LANES), root: Option.some("root-1"), words: new Set(), documents: new Map([["i1", "1".repeat(40)]]), receipts: new Set() })

seeded("no commitment disappears: every open one is held or listed, through restarts, re-orders, hand-backs and triggers", ({ seed, expect }) =>
  onSubject((open) => runSeed(seed, expect, open)),
)

Seed.effect("W: six promised commitments and a reason for each successful follow-up, deferral and decision survive a restart", Effect.gen(function* () {
  type Evidence = ReturnType<typeof coverPromises>
  const cases = {
    "six promises": { field: "promises", expected: ["w0", "w1", "w2", "w3", "w4", "w5"] },
    "follow-up": { field: "followUp", expected: { state: Option.some<State>("open"), last: "promised", reason: Option.some("dependency commitment/w0") } },
    deferral: { field: "deferral", expected: { state: Option.some<State>("open"), last: "deferred", reason: Option.some("guarantee invariant/i1") } },
    decision: { field: "decision", expected: { state: Option.some<State>("decided"), last: "decided", reason: Option.some("guarantee invariant/i1") } },
  } satisfies { [Name in (typeof RECORD_CASES)[number]]: { readonly field: keyof Evidence; readonly expected: Evidence[keyof Evidence] } }
  const ran: Array<string> = []
  for (const [name, { field, expected }] of witnesses(RECORD_CASES, cases)) {
    ran.push(yield* assertEffectWitness(name, expected, (cause) =>
      onSubject((open) => {
        const without = Option.getOrElse(Option.liftPredicate<OmitWitness>(name, () => !cause), (): OmitWitness => "none")
        return coverPromises(open, without)[field]
      })))
  }
  expect(ran.toSorted()).toEqual(RECORD_CASES.toSorted())
}))

Seed.effect(
  "every caller × operation × state × reason class × pointer kind × existence answers as the reference, through a reopen and a restart",
  onSubject((open) => {
    const world = freshWorld()
    const counts = crossProduct(open(world), world)
    // The enumeration reaches both answers of every operation: each took some cases and refused others.
    expect(OPERATIONS.flatMap((operation) => [`${operation} took`, `${operation} refused`]).filter((key) => (counts.get(key) ?? 0) === 0)).toEqual([])
    expect([...counts.values()].reduce((sum, each) => sum + each, 0)).toBe(CALLERS.length * OPERATIONS.length * STATES.length * CLASSES.length * KINDS.length * EXISTENCE.length)
  }),
)
