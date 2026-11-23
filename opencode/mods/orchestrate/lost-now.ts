// The facts lost.ts judges, gathered at the call from the services (status's and the queue check's read): the run
// tables' ready units with their newest request and verdict, the base's lanes against the default branch, and, for the
// few lanes that hold work and have been still past the threshold, who may still be on them. The cheap legs go first
// (git per head, kept per main tip), so the sessions and the process listing are read for the candidates only.
import { Array as Arr, Effect, Option, Schema } from "effect"
import type { Run } from "./idle.ts"
import type { Held } from "./ledger.ts"
import type { Printable } from "./printable.ts"
import { hashReasons, type HeadSeen, IDLE_MS, type LaneSeen, type LaneStatus, lostReport, lostText, OnMain, sameCommit, type SessionSeen, type UnitSeen, Verifier } from "./lost.ts"
import { MainLine, RootHolds, RunFiles, Sessions, StepLog, WorkGit } from "./service.ts"
import { isInternal, type Lane, lanesOf } from "./tools.ts"

/** The base's lanes as the rift plugin lists them, and the base they were made from (none when unread). */
export interface Listed {
  readonly source: Option.Option<string>
  readonly rifts: ReadonlyArray<Lane>
  readonly workrift: boolean
}

/** The default branch's lands read to count those since a hand-back: more than any threshold needs. */
const LANDS_READ = 50

/** A unit state that waits on the unit's lane: its verifier, an owner, or something blocking it. */
const WAITS = /^(verify|waiting|blocked)/
/** A queue item that waits: on the owner or on something else. */
const QUEUE_WAITS = /^(waiting|needs-you)/

const NOT_READ: HeadSeen = { onMain: OnMain.cases.Unknown.make({}), at: Option.none() }

const headOf = (seen: ReadonlyMap<string, HeadSeen>, head: string): HeadSeen => Option.getOrElse(Option.fromUndefinedOr(seen.get(head)), () => NOT_READ)

/** The last segment of a path. */
const folderOf = (path: string): string => Option.getOrElse(Arr.last(path.replace(/\/+$/, "").split("/")), () => path)

/** What waits on `lane`, in words: a unit of it the tables show waiting, else a queue item waiting that names it. */
const waitedOn = (lane: Lane, runs: ReadonlyArray<Run>, listed: Listed, held: Held): Option.Option<string> =>
  Option.orElse(
    Option.map(
      Arr.findFirst(
        runs.flatMap((run) => run.units),
        (unit) => WAITS.test(unit.state) && lanesOf(unit.unit, [lane], listed.workrift).length > 0,
      ),
      (unit) => `unit ${unit.unit} is ${unit.state}`,
    ),
    () =>
      Option.map(
        Arr.findFirst(held.queue, (item) => {
          const said = `${item.text} ${Option.getOrElse(item.detail, () => "")}`
          return QUEUE_WAITS.test(item.state) && [folderOf(lane.path), ...Option.toArray(Option.fromUndefinedOr(lane.branch))].some((name) => said.includes(name))
        }),
        (item) => `queue item "${item.text}" is ${item.state}`,
      ),
  )

/** A session as lost.ts reads it: at work when it started and has not gone idle. */
const sessionSeen = (id: string) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const idleSince = yield* sessions.idleSinceOf(id)
    const started = yield* sessions.startedOf(id)
    return { id, busy: started && Option.isNone(idleSince), idleSince } satisfies SessionSeen
  })

/** The units the tables show ready, or in verify, with their newest request's head; a unit with no head is left out. */
const unitsSeen = (runs: ReadonlyArray<Run>, listed: Listed) =>
  Effect.gen(function* () {
    const files = yield* RunFiles
    const rows = runs.flatMap((run) =>
      Option.toArray(Option.fromUndefinedOr(run.dir)).flatMap((dir) => run.units.filter((unit) => /^(ready|verify)\b/.test(unit.state)).map((unit) => ({ dir: `${dir}/${unit.unit}`, row: unit }))),
    )
    return yield* Effect.forEach(
      rows,
      ({ dir, row }) =>
        Effect.gen(function* () {
          const unit = yield* files.unit(dir)
          if (Option.isNone(unit.request)) return Option.none()
          const request = unit.request.value
          if (Option.isNone(request.head)) return Option.none()
          const requestAt = Option.getOrElse(yield* files.writtenAt(request.path), () => 0)
          const answered = Option.filter(unit.findings, (findings) => findings.round === request.round && Option.isSome(findings.verdict))
          const verifier = yield* Option.match(answered, {
            // A unit in verify with no verdict on this round waits for its verifier (a deep unit before its merge).
            onNone: () =>
              Effect.succeed(
                Option.match(Option.liftPredicate(row.state, (state) => /^verify\b/.test(state)), {
                  onNone: (): Verifier => Verifier.cases.None.make({}),
                  onSome: (): Verifier => Verifier.cases.Pending.make({}),
                }),
              ),
            onSome: (findings) =>
              Effect.map(files.writtenAt(findings.path), (at) =>
                Verifier.cases.Answered.make({ verdict: Option.getOrElse(findings.verdict, () => ""), at: Option.getOrElse(at, () => requestAt) }),
              ),
          })
          return Option.some({
            unit: row.unit,
            dir,
            round: request.round,
            head: request.head.value,
            requestAt,
            lane: Option.map(Arr.head(lanesOf(row.unit, listed.rifts, listed.workrift)), (lane) => lane.path),
            verifier,
          })
        }),
      { concurrency: 8 },
    ).pipe(Effect.map((all) => all.flatMap(Option.toArray)))
  })

/** A lane's place as Ergo's list status says it, when it measured this head without error and found it on main. */
const statusPlace = (lane: Lane, status: Option.Option<LaneStatus>): Option.Option<OnMain> =>
  Option.map(
    Option.filter(status, (each) => Option.isNone(each.error) && each.ahead === 0 && Option.match(each.head, { onNone: () => true, onSome: (head) => sameCommit(head, lane.head) })),
    (each) => Option.match(Option.filter(each.by, (by) => by === "patch"), { onNone: () => OnMain.cases.Landed.make({}), onSome: () => OnMain.cases.Equivalent.make({}) }),
  )

/** A lane's last commit as Ergo's list status says it, for this head, without error. */
const statusCommit = (lane: Lane, status: Option.Option<LaneStatus>): Option.Option<number> =>
  Option.flatMap(
    Option.filter(status, (each) => Option.isNone(each.error) && Option.match(each.head, { onNone: () => true, onSome: (head) => sameCommit(head, lane.head) })),
    (each) => each.lastCommit,
  )

/** What the lists are read from, at one call: the units and lanes as seen, the default branch's lands, and the heads git placed. */
const seenNow = Effect.fn("Orchestrate.seenNow")(function* (sessionID: string, checkout: string, runs: ReadonlyArray<Run>, listed: Listed, now: number, hashes: ReadonlyArray<string>) {
  const git = yield* WorkGit
  const tip = yield* (yield* MainLine).tip(checkout, Option.none())
  if (Option.isNone(tip)) return Option.none()
  const repo = Option.getOrElse(listed.source, () => checkout)
  const main = tip.value.head
  const units = yield* unitsSeen(runs, listed)
  const lanes = listed.rifts.filter((lane) => !isInternal(lane))
  // Ergo's own measure of each lane, when the installed `work` gives one: a lane it finds on main needs no git.
  const statuses = yield* git.statuses(repo)
  const statusOf = (lane: Lane) => Option.fromUndefinedOr(statuses.get(lane.path))
  const placedByStatus = new Map(lanes.flatMap((lane) => Option.toArray(Option.map(statusPlace(lane, statusOf(lane)), (onMain) => [lane.head, onMain] as const))))
  // Each head borrows only the lanes that may hold it: its own; a unit's whose lane is gone, and a commit a queue names, every lane (a stack may carry it).
  const every = lanes.map((lane) => lane.path)
  const asked = [
    ...lanes.filter((lane) => !placedByStatus.has(lane.head)).map((lane) => ({ head: lane.head, lanes: [lane.path] })),
    ...units.map((unit) => ({ head: unit.head, lanes: Option.match(unit.lane, { onNone: () => every, onSome: (path) => [path] }) })),
    ...hashes.map((hash) => ({ head: hash, lanes: every })),
  ]
  const read = yield* git.heads(
    repo,
    main,
    Arr.dedupe(asked.map((each) => each.head)).map((head) => ({ head, lanes: Arr.dedupe(asked.flatMap((each) => Arr.filter(each.lanes, () => each.head === head))) })),
  )
  const seen = new Map([...read, ...[...placedByStatus].map(([head, onMain]) => [head, { onMain, at: Option.none<number>() }] as const)])
  const lands = yield* git.lands(repo, main, LANDS_READ)
  // A lane holds work when it has commits not on main, or uncommitted ones.
  const holdsWork = (lane: Lane) => lane.state !== "clean" || OnMain.guards.Absent(headOf(seen, lane.head).onMain)
  const placed = yield* Effect.forEach(
    lanes,
    (lane) => {
      const head = headOf(seen, lane.head)
      // A lane that holds no work is never listed: its activity is not read (now stands in), only its head (a stack's carrier).
      if (!holdsWork(lane)) return Effect.succeed({ lane, head, activeAt: now })
      const committed = Math.max(Option.getOrElse(head.at, () => 0), Option.getOrElse(statusCommit(lane, statusOf(lane)), () => 0))
      return Effect.map(git.touchedAt(lane.path), (touched) => ({ lane, head, activeAt: Math.max(committed, Option.getOrElse(touched, () => 0)) }))
    },
    { concurrency: 16 },
  )
  const held = yield* (yield* RootHolds).held(sessionID)
  const waiting = placed.map((each) => ({ ...each, waited: waitedOn(each.lane, runs, listed, held) }))
  // Who is on a lane is read only for a candidate: one holding work, still past the threshold, that nothing waits on.
  const candidate = (each: (typeof waiting)[number]) => holdsWork(each.lane) && now - each.activeAt >= IDLE_MS && Option.isNone(each.waited)
  const working = yield* git.held(waiting.filter(candidate).map((each) => each.lane.path))
  const children = (yield* (yield* StepLog).calls(sessionID)).children
  const sessions = yield* Sessions
  const lanesSeen = yield* Effect.forEach(
    waiting,
    (each) =>
      Effect.gen(function* () {
        if (!candidate(each)) return { ...each, held: false, sessions: [] } satisfies LaneSeen
        const named = children.filter((child) => Option.exists(child.description, (said) => said.includes(`(lane: ${each.lane.path})`))).map((child) => child.child)
        const ids = Arr.dedupe([...(yield* sessions.inDirectory(each.lane.path)), ...named])
        const on = yield* Effect.forEach(ids, sessionSeen, { concurrency: 8 })
        return { ...each, held: working.has(each.lane.path), sessions: on } satisfies LaneSeen
      }),
    { concurrency: 8 },
  )
  const unitsWithPlace: ReadonlyArray<UnitSeen> = units.map((unit) => ({ ...unit, onMain: headOf(seen, unit.head).onMain }))
  return Option.some({ units: unitsWithPlace, lanes: lanesSeen, lands, hashes: new Map(hashes.map((hash) => [hash, headOf(seen, hash)] as const)) })
})

/**
 * What status says of lost work, for the root `sessionID` in `checkout`: the unit-first list, then the lane-first
 * lists, then what to do (lost.ts); nothing when nothing is lost or the default branch cannot be read.
 */
export const lostNow = (sessionID: string, checkout: string, runs: ReadonlyArray<Run>, listed: Listed, now: number) =>
  Effect.map(seenNow(sessionID, checkout, runs, listed, now, []), (seen) =>
    Option.match(seen, { onNone: (): ReadonlyArray<string> => [], onSome: (each) => lostText(each.units, each.lanes, each.lands, now) }),
  )

/** The queue check's answer (`LOST_RPC`): status's lists with their keys, to a root that started a unit's step only, and the commits `hashes` that are due. */
export interface LostAnswer {
  readonly lines: ReadonlyArray<string>
  readonly keys: ReadonlyArray<string>
  readonly hashes: ReadonlyArray<{ readonly hash: string; readonly why: string }>
}

export const NOTHING: LostAnswer = { lines: [], keys: [], hashes: [] }

/** The answer with the commitment record's section after its lists (commitments-tool.ts `sectionOf`), its keys with theirs. */
export const withRecordSection = (answer: LostAnswer, section: { readonly lines: ReadonlyArray<Printable>; readonly keys: ReadonlyArray<string> }): LostAnswer => ({
  ...answer,
  lines: [...answer.lines, ...section.lines],
  keys: [...answer.keys, ...section.keys],
})

/** What the queue check asks: for the root `sessionID`, and the commits its open items name. */
export const LostAsk = Schema.Struct({ sessionID: Schema.String, hashes: Schema.Array(Schema.String) })
export type LostAsk = typeof LostAsk.Type

/**
 * Lost work's RPC, for the queue check (mods/queue/opencode/host.ts keeps its copy, `ORCHESTRATE_LOST`).
 * - `lost({ sessionID, hashes })`: `lostAnswer` for that root; nothing when it cannot be read.
 */
export const LOST = {
  id: "dotfiles-opencode.orchestrate.lost",
  methods: {
    lost: {
      input: { type: "object", properties: { sessionID: { type: "string" }, hashes: { type: "array", items: { type: "string" } } }, required: ["sessionID", "hashes"] },
      output: { type: "object" },
    },
  },
  events: {},
} as const

/**
 * What the queue check tells the root `sessionID`: the same lists `orchestrate status` starts with (one source, two
 * surfaces), when the root runs units (it started a step of one), and why each commit of `hashes` its queue names is
 * due. A lane is only ever this repository's (the base the rift plugin lists for this location), and a commit of
 * another repository is unknown here, so neither is named.
 */
export const lostAnswer = Effect.fn("Orchestrate.lostAnswer")(function* (
  sessionID: string,
  checkout: string,
  runs: ReadonlyArray<Run>,
  listed: Listed,
  now: number,
  hashes: ReadonlyArray<string>,
) {
  const orchestrates = (yield* (yield* StepLog).units(sessionID)).length > 0
  // A root that runs no unit is told of no lane or unit: neither is read for it, only the commits its queue names.
  const seen = yield* Option.match(Option.liftPredicate(listed, () => orchestrates), {
    onNone: () => seenNow(sessionID, checkout, [], { ...listed, rifts: [] }, now, Arr.dedupe(hashes)),
    onSome: (all) => seenNow(sessionID, checkout, runs, all, now, Arr.dedupe(hashes)),
  })
  return Option.match(seen, {
    onNone: () => NOTHING,
    onSome: (each): LostAnswer => {
      const report = lostReport(each.units, each.lanes, each.lands, now)
      return {
        lines: Arr.match(report.keys, { onEmpty: () => [], onNonEmpty: () => report.lines }),
        keys: report.keys,
        hashes: [...hashReasons(each.hashes, each.lands, now)].map(([hash, why]) => ({ hash, why })),
      }
    },
  })
})
