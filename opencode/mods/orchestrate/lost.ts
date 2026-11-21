// Finished work that never reached the default branch, as `orchestrate status` and the queue check say it. Pure: the
// plugin gathers the facts at each call (git in the base with the lanes' objects borrowed read-only, the lanes' own
// files, the processes' working directories, the sessions, the run dirs' request files) and nothing here is kept, so
// the answer survives a compaction and a restart. Two sources, one rule of time:
// - lane-first (the primary one): a lane holding commits not on the default branch (none patch-equivalent there)
//   that nobody is on: its last activity past the threshold, no process working in it, every session on it ended,
//   and nothing the run tables or the queue name waits on it. A lane with uncommitted work and nobody on it is the
//   same loss one step earlier, in a second short list.
// - unit-first: a unit whose newest request handed back a head that is neither on the default branch nor
//   patch-equivalent there, past the threshold, its lane gone or not.
import { Array as Arr, Match, Option, Order, Schema } from "effect"
import type { Lane } from "./tools.ts"
import { isInternal } from "./tools.ts"

/** Work untouched this long is past the threshold… */
export const IDLE_MS = 6 * 3_600_000
/** …or work this many lands on the default branch went by since. */
export const LANDS_PAST = 2
/** Each list names at most this many, oldest first, and counts the rest. */
export const LISTED = 10

/**
 * Where a head stands against the default branch: `Landed`, an ancestor of it; `Equivalent`, not an ancestor but every
 * commit of its own patch-equivalent to one on it (a squash, a rebase, a cherry-pick); `Absent`, commits of its own on
 * it under no hash (`missing`, full hashes newest first; `own`, all its commits not on it; `subject`, its newest
 * missing commit's); `Unknown`, the repository and the lanes it borrows from have no such commit (its lane is gone).
 */
export const OnMain = Schema.TaggedUnion({
  Landed: {},
  Equivalent: {},
  Absent: { missing: Schema.Array(Schema.String), own: Schema.Array(Schema.String), subject: Schema.String },
  Unknown: {},
})
export type OnMain = typeof OnMain.Type

/** A head's commits not on the default branch, when some are there under no hash. */
type Absent = typeof OnMain.cases.Absent.Type
const absentOf = (onMain: OnMain): Option.Option<Absent> => Option.liftPredicate(onMain, OnMain.guards.Absent)

/** A head as git reads it: where it stands, and when it was committed (epoch ms; none when unknown). */
export interface HeadSeen {
  readonly onMain: OnMain
  readonly at: Option.Option<number>
}

/** A session on a lane: its id, whether a turn runs now, and when its last turn ended. */
export interface SessionSeen {
  readonly id: string
  readonly busy: boolean
  readonly idleSince: Option.Option<number>
}

/** One lane with what the plugin found around it. */
export interface LaneSeen {
  readonly lane: Lane
  readonly head: HeadSeen
  /** Its last activity (epoch ms): its head's commit time, or its HEAD reflog's last write when later. */
  readonly activeAt: number
  /** A process has its working directory in it now. */
  readonly held: boolean
  /** The sessions known to work in it: those whose directory it is, and subagents whose description names it. */
  readonly sessions: ReadonlyArray<SessionSeen>
  /** What waits on it, in words (a unit in verify or blocked, a queue item waiting); none when nothing does. */
  readonly waited: Option.Option<string>
}

/** `40 min`, `9 h`, `7 d`. */
export const ageOf = (ms: number): string => {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  return Match.value(minutes).pipe(
    Match.when((n) => n < 120, (n) => `${n} min`),
    Match.when((n) => n < 48 * 60, (n) => `${Math.floor(n / 60)} h`),
    Match.orElse((n) => `${Math.floor(n / 1440)} d`),
  )
}

/** Why nobody is on a lane, or none when someone may be: a process in it, a session at work or idle within the threshold, recent activity. */
export const nobodyOn = (seen: LaneSeen, now: number): boolean =>
  !seen.held &&
  now - seen.activeAt >= IDLE_MS &&
  seen.sessions.every((session) => !session.busy && Option.match(session.idleSince, { onNone: () => true, onSome: (idle) => now - idle >= IDLE_MS }))

/** The sessions of a lane in words: the newest first, or `no session known`. */
const sessionsText = (sessions: ReadonlyArray<SessionSeen>): string =>
  Arr.match(sessions, { onEmpty: () => "no session known", onNonEmpty: (all) => `session ${all.map((each) => each.id).join(", ")}` })

/** The other lanes whose own commits hold `commit`: a stack it rides in, not on the default branch. */
const carriersOf = (commit: string, self: string, lanes: ReadonlyArray<LaneSeen>): ReadonlyArray<string> =>
  lanes.flatMap((other) =>
    Option.toArray(
      Option.liftPredicate(other.lane.path, () => other.lane.path !== self && Option.exists(absentOf(other.head.onMain), (absent) => absent.own.some((sha) => sameCommit(sha, commit)))),
    ),
  )

/** Two names of one commit: one a prefix of the other (a request names 7 to 40 hex). */
export const sameCommit = (a: string, b: string): boolean => a !== "" && b !== "" && (a.startsWith(b) || b.startsWith(a))

const carriedText = (carriers: ReadonlyArray<string>): string => Arr.match(carriers, { onEmpty: () => "", onNonEmpty: (all) => ` · carried by ${all.join(", ")}` })

/** The capped list of `lines` under `heading`: none when empty. */
const section = (heading: string, lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  Arr.match(lines, {
    onEmpty: () => [],
    onNonEmpty: (all) => [`${heading} (${all.length}, oldest first):`, ...all.slice(0, LISTED), ...Arr.filter([`- and ${all.length - LISTED} more`], () => all.length > LISTED)],
  })

const byActive = Order.mapInput(Order.Number, (seen: LaneSeen) => seen.activeAt)

/** The lanes nobody is on that nothing waits on: a land's or a verify's own checkouts never. */
const idleLanes = (lanes: ReadonlyArray<LaneSeen>, now: number, skip: ReadonlySet<string>): ReadonlyArray<LaneSeen> =>
  Arr.sort(
    lanes.filter((seen) => !isInternal(seen.lane) && !skip.has(seen.lane.path) && Option.isNone(seen.waited) && nobodyOn(seen, now)),
    byActive,
  )

/** `1 commit`, `3 commits`. */
const commitsText = (count: number): string =>
  Match.value(count).pipe(
    Match.when(1, () => "1 commit"),
    Match.orElse((n) => `${n} commits`),
  )

/** ` · also <state>` for a lane with uncommitted work. */
const dirtyText = (state: string): string =>
  Match.value(state).pipe(
    Match.when("clean", () => ""),
    Match.orElse((dirty) => ` · also ${dirty}`),
  )

/** The lane-first lists: committed work not on main nobody is on, then uncommitted work nobody is on. */
export const lostLanes = (lanes: ReadonlyArray<LaneSeen>, now: number, skip: ReadonlySet<string> = new Set()): ReadonlyArray<string> => {
  const idle = idleLanes(lanes, now, skip)
  const committed = idle.flatMap((seen) =>
    Option.toArray(
      Option.map(
        absentOf(seen.head.onMain),
        (absent) =>
          `- ${seen.lane.path} · ${ageOf(now - seen.activeAt)} · ${commitsText(absent.missing.length)} · ${absent.subject} · ${sessionsText(seen.sessions)}${carriedText(carriersOf(seen.lane.head, seen.lane.path, lanes))}${dirtyText(seen.lane.state)}`,
      ),
    ),
  )
  const uncommitted = idle.flatMap((seen) =>
    Option.toArray(
      Option.liftPredicate(
        `- ${seen.lane.path} · ${ageOf(now - seen.activeAt)} · ${seen.lane.state} · ${sessionsText(seen.sessions)}`,
        () => seen.lane.state !== "clean" && Option.isNone(absentOf(seen.head.onMain)),
      ),
    ),
  )
  return [...section("orchestrate: committed work not on main, nobody on it", committed), ...section("orchestrate: uncommitted work, nobody on it", uncommitted)]
}

// ── Unit-first: a ready hand-back that never landed ──

/** A unit's verifier for its newest round: none, one still to answer (`Pending`), or its verdict and when it was written. */
export const Verifier = Schema.TaggedUnion({
  None: {},
  Pending: {},
  Answered: { verdict: Schema.String, at: Schema.Number },
})
export type Verifier = typeof Verifier.Type

/** A unit the run tables show ready (or in verify) with its newest request and what git and the run dir say of it. */
export interface UnitSeen {
  readonly unit: string
  readonly dir: string
  readonly round: number
  readonly head: string
  /** When its newest request was written (epoch ms). */
  readonly requestAt: number
  readonly onMain: OnMain
  /** Its lane's path; none when it was removed. */
  readonly lane: Option.Option<string>
  readonly verifier: Verifier
}

/** How many of the default branch's lands (first-parent commit times, epoch ms) came after `since`. */
const landsAfter = (lands: ReadonlyArray<number>, since: number): number => lands.filter((at) => at > since).length

const onMainNow = (onMain: OnMain): boolean => OnMain.guards.Landed(onMain) || OnMain.guards.Equivalent(onMain)
const changesAsked = (verifier: Verifier): boolean => Option.exists(Option.liftPredicate(verifier, Verifier.guards.Answered), (answered) => /^changes\b/.test(answered.verdict))

/** What one unit row says, or none: a verdict of `changes` waits for its next round; a head on main, or patch-equivalent there, landed. */
const unitLine = (seen: UnitSeen, lanes: ReadonlyArray<LaneSeen>, lands: ReadonlyArray<number>, now: number): Option.Option<string> => {
  if (onMainNow(seen.onMain) || changesAsked(seen.verifier)) return Option.none()
  const lane = Option.getOrElse(seen.lane, () => "lane gone")
  const head = seen.head.slice(0, 9)
  if (Verifier.guards.Pending(seen.verifier)) return Option.some(`- ready, with its verifier: ${seen.unit} ${head} ${lane}`)
  const since = Verifier.match(seen.verifier, { None: () => seen.requestAt, Pending: () => seen.requestAt, Answered: (answered) => answered.at })
  if (now - since < IDLE_MS && landsAfter(lands, since) < LANDS_PAST) return Option.none()
  const unknown = OnMain.match(seen.onMain, { Landed: () => "", Equivalent: () => "", Absent: () => "", Unknown: () => " · head not in this repository" })
  return Option.some(`- ready, not landed ${ageOf(now - since)}: ${seen.unit} ${head} ${lane}${unknown}${carriedText(carriersOf(seen.head, Option.getOrElse(seen.lane, () => ""), lanes))}`)
}

const byRequest = Order.mapInput(Order.Number, (seen: UnitSeen) => seen.requestAt)

/** The unit-first list: each ready unit past the threshold whose head never reached the default branch; one with its verifier is named, not counted lost. */
export const readyNotLanded = (units: ReadonlyArray<UnitSeen>, lanes: ReadonlyArray<LaneSeen>, lands: ReadonlyArray<number>, now: number): ReadonlyArray<string> =>
  section(
    "orchestrate: ready, not landed",
    Arr.sort(units, byRequest).flatMap((seen) => Option.toArray(unitLine(seen, lanes, lands, now))),
  )

/** The lanes the unit-first list names: the lane-first list leaves them to it, so no lane is named twice. */
export const lanesNamed = (units: ReadonlyArray<UnitSeen>, lanes: ReadonlyArray<LaneSeen>, lands: ReadonlyArray<number>, now: number): ReadonlySet<string> =>
  new Set(units.flatMap((seen) => Option.toArray(Option.filter(seen.lane, () => Option.isSome(unitLine(seen, lanes, lands, now))))))

/** What to do with a lost hand-back or lane: land it, or end it where status reads it. */
export const LOST_FIX =
  "Land each (orchestrate land), or end it: a unit's with `bun ~/.claude/skills/orchestrate/scripts/log.ts --current <unit dir> dropped r<N> superseded-by <hash>` (or `dropped r<N> <reason>`); push or drop a lane's work before you remove the lane."

/** Both lists, the unit-first first (it names the unit and its request), then the lane-first, then what to do; none when nothing is lost. */
export const lostText = (units: ReadonlyArray<UnitSeen>, lanes: ReadonlyArray<LaneSeen>, lands: ReadonlyArray<number>, now: number): ReadonlyArray<string> => {
  const lines = [...readyNotLanded(units, lanes, lands, now), ...lostLanes(lanes, now, lanesNamed(units, lanes, lands, now))]
  return Arr.match(Arr.filter(lines, (line) => line.startsWith("- ") && !line.startsWith("- ready, with its verifier")), {
    onEmpty: () => lines,
    onNonEmpty: () => [...lines, LOST_FIX],
  })
}
