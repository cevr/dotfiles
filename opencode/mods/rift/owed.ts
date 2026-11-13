// The post-land step a land owes. A land's post-land step (`rift.postLand`) is owed from the push until it
// has run; while the host is loaded past its cores it stays owed rather than being dropped. One step is owed
// per warm source, over every land since one last ran: a later land's replaces the one owed (only the newest
// runs), kept beside the land logs so a server restart keeps it. Every load reading the tool takes, a land's
// or the minute check's, feeds one settle window (`Readings`): one at or past the cores restarts it. The
// rift plugin's check, every CHECK_EVERY, runs an owed step once its readings have stayed under the cores
// for SETTLE; a land runs its own at once when no reading in the last SETTLE was at or past them, and once
// the step has been owed MAX_WAIT, whatever the load (heavy, so nice'd), and says so. Where the rule says
// defer, the step still runs, `loaded` (`phase`): a land's at once, the minute check's once LOADED_EVERY has
// passed since its last run; it does what a loaded host allows (RIFT_POST_LAND_LOAD=loaded) and stays owed.
// This file holds the rules and the words; model.ts runs them.
import { Array as Arr, Duration, Option, Schema } from "effect"
import type { HostLoad, Unit } from "./land.ts"

/** How often the plugin reads the load while a post-land step is owed. */
export const CHECK_EVERY = Duration.minutes(1)
/** How long the load must stay under the host's cores before the check runs an owed step. */
export const SETTLE = Duration.minutes(5)
/** How long a step stays owed before a land runs it whatever the load. */
export const MAX_WAIT = Duration.hours(6)

/** One pushed land whose post-land step has not run. */
export const OwedLand = Schema.Struct({
  /** The batch's base, RIFT_LAND_BASE when it is the oldest owed. */
  base: Schema.String,
  /** The pushed commit, RIFT_LAND_HEAD when it is the newest. */
  head: Schema.String,
  /** The Rifts it landed. */
  units: Schema.Array(Schema.Struct({ path: Schema.String, branch: Schema.String })),
  /** When it was pushed, epoch milliseconds. */
  at: Schema.Finite,
})
export type OwedLand = typeof OwedLand.Type

/** The post-land step owed for a warm source: one run, as the newest land's, over every land owed, oldest first. */
export const OwedPostLand = Schema.Struct({
  /** The warm source whose post-land Rift it runs in. */
  source: Schema.String,
  /** The default branch the post-land Rift is put at, as the newest land read it. */
  main: Schema.String,
  /** `rift.postLand`, as the newest land read it. */
  command: Schema.String,
  /** The session woken with its report: the newest land's. */
  sessionID: Schema.String,
  lands: Schema.NonEmptyArray(OwedLand),
  /** When a `loaded` run of the step (one that leaves it owed) last ended, epoch milliseconds; absent before the first. */
  ranAt: Schema.optionalKey(Schema.Finite),
})
export type OwedPostLand = typeof OwedPostLand.Type

/** What the store keeps: the owed steps, and the newest load reading at or past the cores (`Readings.loadedAt`). */
export const Debts = Schema.Struct({
  owed: Schema.Array(OwedPostLand),
  loadedAt: Schema.OptionFromOptionalKey(Schema.Finite),
})
export type Debts = typeof Debts.Type

/** Nothing owed, and no reading at or past the cores. */
export const noDebts: Debts = { owed: [], loadedAt: Option.none() }

/** RIFT_LAND_BASE: the oldest owed land's base, so the step sees every batch it covers. */
export const baseOf = (owed: OwedPostLand): string => Arr.headNonEmpty(owed.lands).base
/** RIFT_LAND_HEAD: the newest land's pushed commit. */
export const headOf = (owed: OwedPostLand): string => Arr.lastNonEmpty(owed.lands).head
/** The Rifts of every owed land, oldest first. */
export const unitsOf = (owed: OwedPostLand): ReadonlyArray<Unit> => owed.lands.flatMap((land) => land.units)
/** When the step was first owed: the oldest owed land's push. */
export const sinceOf = (owed: OwedPostLand): number => Arr.headNonEmpty(owed.lands).at

/** One land as the step it owes, before it meets what its source owed already. */
export interface Owing {
  readonly source: string
  readonly main: string
  readonly command: string
  readonly sessionID: string
  readonly land: OwedLand
}

/** The owed steps after a land: its source's step now the land's, over the lands owed before it too. */
export const owe = (all: ReadonlyArray<OwedPostLand>, owing: Owing): ReadonlyArray<OwedPostLand> => {
  const before = Option.fromNullishOr(all.find((owed) => owed.source === owing.source))
  const newest = { source: owing.source, main: owing.main, command: owing.command, sessionID: owing.sessionID }
  // The step's last loaded run stays its last run: a later land does not make the minute check run it sooner.
  const owed: OwedPostLand = Option.match(before, {
    onNone: () => ({ ...newest, lands: Arr.of(owing.land) }),
    onSome: (kept) => ({ ...kept, ...newest, lands: Arr.append(kept.lands, owing.land) }),
  })
  return [...all.filter((each) => each.source !== owing.source), owed]
}

/** The owed steps once the source's step ran at all, ending at `at`: the time the minute check counts its next loaded run from. */
export const ran = (all: ReadonlyArray<OwedPostLand>, source: string, at: number): ReadonlyArray<OwedPostLand> =>
  all.map((owed) => Option.match(Option.liftPredicate(owed, (each) => each.source === source), { onNone: () => owed, onSome: (mine) => ({ ...mine, ranAt: at }) }))

/**
 * The owed steps once the source's step ran for `head`: the lands up to that one are paid, and a land owed
 * while it ran stays owed, its base where that run ended.
 */
export const pay = (all: ReadonlyArray<OwedPostLand>, source: string, head: string): ReadonlyArray<OwedPostLand> =>
  all.flatMap((owed) => {
    if (owed.source !== source) return [owed]
    const ran = owed.lands.findLastIndex((land) => land.head === head)
    const left = owed.lands.slice(ran + 1)
    if (!Arr.isReadonlyArrayNonEmpty(left)) return []
    return [{ ...owed, lands: left }]
  })

/** Whether the host is too loaded for a post-land step: the 1-minute load at or past its cores. */
export const overloaded = (load: HostLoad): boolean => load.load >= load.cores

/** How long `owed` has been owed at `now`. */
export const owedFor = (owed: OwedPostLand, now: number): Duration.Duration => Duration.millis(Math.max(0, now - sinceOf(owed)))

/** Whether `owed` has waited MAX_WAIT or more. */
export const overdue = (owed: OwedPostLand, now: number): boolean => Duration.isGreaterThanOrEqualTo(owedFor(owed, now), MAX_WAIT)

/** Who asks for an owed step: a land, or the plugin's check after the load settled. */
export type Trigger = "land" | "settled"

/** What an owed step does now: runs, runs past the load (a land, past MAX_WAIT), or stays owed. */
export type Verdict = "run" | "forced" | "defer"

/**
 * What the tool's load readings say, from every reader (a land, the minute check). `calmSince`: the first of
 * the unbroken run of readings under the cores up to now (none after a reading at or past them, and none
 * before this server's first reading). `loadedAt`: the newest reading at or past the cores, kept with the
 * owed steps so a restart keeps it.
 */
export interface Readings {
  readonly calmSince: Option.Option<number>
  readonly loadedAt: Option.Option<number>
}

/** The readings after one more, taken at `now`: one at or past the cores restarts the settle window. */
export const observe = (before: Readings, load: HostLoad, now: number): Readings => {
  if (overloaded(load)) return { calmSince: Option.none(), loadedAt: Option.some(now) }
  return { calmSince: Option.orElse(before.calmSince, () => Option.some(now)), loadedAt: before.loadedAt }
}

const atLeast = (from: number, now: number, duration: Duration.Duration): boolean => Duration.isGreaterThanOrEqualTo(Duration.millis(now - from), duration)

/** Whether no reading in the SETTLE before `now`, by any reader on the host, was at or past the cores: a land's rule. */
export const quiet = (readings: Readings, now: number): boolean => !Option.exists(readings.loadedAt, (at) => !atLeast(at, now, SETTLE))

/**
 * Whether this plugin instance's own readings have stayed under the cores for SETTLE by `now`, and no reader
 * on the host (another instance, through the kept `loadedAt`) read one at or past them since: the minute
 * check's rule.
 */
export const settled = (readings: Readings, now: number): boolean => Option.exists(readings.calmSince, (since) => atLeast(since, now, SETTLE)) && quiet(readings, now)

/**
 * The rule, over the readings with the one just taken: a land runs it when no reading in the last SETTLE was
 * at or past the cores, the minute check when the readings have stayed under them for SETTLE; else it stays
 * owed, unless a land finds it owed MAX_WAIT or more, which runs it whatever the load.
 */
export const verdict = (owed: OwedPostLand, readings: Readings, now: number, trigger: Trigger): Verdict => {
  if (trigger === "land" && quiet(readings, now)) return "run"
  if (trigger === "settled" && settled(readings, now)) return "run"
  if (trigger === "land" && overdue(owed, now)) return "forced"
  return "defer"
}

/** How long the minute check leaves an owed step after its last run before it runs it `loaded` again. */
export const LOADED_EVERY = Duration.minutes(30)

/**
 * How a step runs now, as RIFT_POST_LAND_LOAD says it: `run` (settled) and `forced` as `verdict` says, and
 * where it says defer, `loaded` (the step does what a loaded host allows and stays owed) for a land, and for
 * the minute check once LOADED_EVERY has passed since the step's last run (or it never ran); else `wait`.
 */
export type Phase = "run" | "forced" | "loaded" | "wait"

export const phase = (owed: OwedPostLand, readings: Readings, now: number, trigger: Trigger): Phase => {
  const decided = verdict(owed, readings, now, trigger)
  if (decided !== "defer") return decided
  if (trigger === "land") return "loaded"
  if (Option.exists(Option.fromUndefinedOr(owed.ranAt), (at) => !atLeast(at, now, LOADED_EVERY))) return "wait"
  return "loaded"
}

/** Whether a run in `phase` pays the step: a `loaded` run leaves it owed. */
export const pays = (phase: Phase): boolean => phase === "run" || phase === "forced"

/** The RIFT_POST_LAND_LOAD word of a phase that runs. */
export const loadWord = (phase: Exclude<Phase, "wait">): string => ({ run: "settled", forced: "forced", loaded: "loaded" })[phase]

const branches = (units: ReadonlyArray<Unit>): string => units.map((unit) => unit.branch).join(", ")

const minutesOf = (duration: Duration.Duration): number => Math.round(Duration.toMinutes(duration))

/** Why the load holds a step back: the reading now, else the newest one at or past the cores and how long ago it came. */
const loadWords = (load: HostLoad, readings: Readings, now: number): string => {
  if (overloaded(load)) return `the 1-minute load is ${load.load.toFixed(1)}, at or past the host's ${load.cores} cores`
  const ago = Option.getOrElse(Option.map(readings.loadedAt, (at) => Math.round((now - at) / Duration.toMillis(Duration.minutes(1)))), () => 0)
  return `the 1-minute load is ${load.load.toFixed(1)}, but it was at or past the host's ${load.cores} cores ${ago} min ago`
}

/**
 * The line that heads the report of a step run `loaded`: what ran (what a loaded host allows: the owed
 * acceptance files that bound no time) and what still waits (the rest, and the upstream merge), and when.
 */
export const loadedLine = (owed: OwedPostLand, load: HostLoad, readings: Readings, now: number): string =>
  [
    `rift land: the post-land step after ${branches(unitsOf(owed))} ran loaded (${loadWords(load, readings, now)}): it ran what a loaded host allows, and the rest still waits, so the step stays owed.`,
    `It runs in full once the load has stayed under ${load.cores} for ${minutesOf(SETTLE)} minutes, or at the first land after ${minutesOf(MAX_WAIT) / 60} hours owed whatever the load; until then the next land, or every ${minutesOf(LOADED_EVERY)} minutes the minute check, runs it loaded again.`,
  ].join(" ")

/**
 * The line that heads the report of a step a land ran past the load, worded as the deferred wake words it:
 * the reading now when it is at or past the cores, else the earlier one that held the step back.
 */
export const forcedLine = (owed: OwedPostLand, load: HostLoad, readings: Readings, now: number): string =>
  `rift land: the post-land step was owed for ${minutesOf(owedFor(owed, now))} minutes, past the ${minutesOf(MAX_WAIT) / 60}-hour wait, so this land ran it whatever the load (${loadWords(load, readings, now)}), nice'd like every check.`
