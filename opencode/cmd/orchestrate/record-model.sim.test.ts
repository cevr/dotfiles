// The acceptance check of the commitment record, model-based: seeded sequences of approvals with N parts, reports'
// follow-ups, assignments, re-owning, orders to an owner, hand-backs with and without a root, restarts, compactions
// (the checkpoint read), triggers turning true (a commit on the default branch, another commitment closing, a date, the
// root's word), lanes ending, decisions and reopenings, against the reference model (record-model.ts) and against the
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
//      SUBJECT=wakes-twice bun test …   (a mutant: red; record-subject.ts names the five)
//      SIM_SEED=<n> replays one seed.
// Moved from the planner's acceptance/record-model.test.ts: the generator rewritten within the effect-debt rules on the
// seed runner's generator, the assertions the same.
import { Array as Arr, Config, Effect, Option, type Random } from "effect"
import { below, generator } from "../../sim/runtime.ts"
import * as Seed from "../../sim/seed.ts"
import { platform } from "@dotfiles/opencode-orchestrate/node/platform"
import * as SqliteRecord from "@dotfiles/opencode-orchestrate/sqlite/record"
import { scratch } from "../../tests/scratch.ts"
import { type Answer, type Happened, makeModel, okOf, type State, type Subject, type Trigger, type World } from "./record-model.ts"
import { type Opened, SUBJECTS } from "./record-subject.ts"

const FILE = "cmd/orchestrate/record-model.sim.test.ts"
const { seeded } = Seed.runner(FILE)

const STEPS = 90
const OWNERS: Arr.NonEmptyReadonlyArray<string> = ["L1", "L2", "L3", "root"]
const LANES: Arr.NonEmptyReadonlyArray<string> = ["L1", "L2", "L3"]
const WORDS: Arr.NonEmptyReadonlyArray<string> = ["w1", "w2"]
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

const whyOf = (run: Run) => {
  if (next(run) < 0.15) return " "
  return "superseded"
}

const decide = (run: Run) =>
  withPick(run, run.books.promised, (id) => {
    const input = { id, why: whyOf(run), by: "someone", role: pick(run, ["root", "root", "worker"] as const) }
    const got = subjectOf(run).decide(input)
    same(run, got, run.reference.decide(input), "decide")
    if ("ok" in got) run.books.decided.add(id)
  })

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

const observed = (subject: Subject) => ({ check: subject.check(), checkpoint: subject.checkpoint(), notices: subject.notices() })

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

const runSeed = (seed: number, expect: Seed.Seeded["expect"], open: (world: World) => Opened) => {
  const world: World = { now: 1_000_000, main: new Set(), alive: new Set(LANES), root: Option.some("root-1"), words: new Set() }
  const opened = open(world)
  const books: Books = { promised: [], claimed: new Map(), decided: new Set(), epoch: new Map(), woken: new Set(), commits: [], handBacks: [], counts: { roots: 1, minted: 0, step: 0 } }
  const run: Run = { world, random: generator(seed), expect, opened, held: { subject: opened.subject }, reference: makeModel(world), books }
  for (books.counts.step = 0; books.counts.step < STEPS; books.counts.step += 1) {
    commandOf(run)(run)
    ticked(run)
    compared(run)
  }
  opened.close()
  // The generator did generate: a run that promises nothing proves nothing.
  expect(books.promised.length).toBeGreaterThan(5)
}

seeded("no commitment disappears: every open one is held or listed, through restarts, re-orders, hand-backs and triggers", ({ seed, expect }) =>
  Effect.gen(function* () {
    const name = yield* subjectName
    const make = yield* Effect.fromOption(Option.fromUndefinedOr(SUBJECTS.get(name))).pipe(
      Effect.mapError(() => new Seed.SeedFailed({ message: `SUBJECT=${name}: not a subject; record-subject.ts names them` })),
    )
    yield* Effect.acquireUseRelease(
      // The file made and migrated as the plugin's start makes it; the built subject attaches to it, a restart attaches again.
      Effect.tap(Effect.sync(() => scratch("record-model-")), (dir) => Effect.scoped(SqliteRecord.open(`${dir.path}/record.db`, { readonly: false, now: 1_000_000 })).pipe(Effect.orDie)),
      (dir) => Effect.sync(() => runSeed(seed, expect, (world) => make(`${dir.path}/record.db`, world))),
      (dir) => Effect.sync(() => dir[Symbol.dispose]()),
    )
  }).pipe(Effect.provide(platform)),
)
