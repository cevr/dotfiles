// What each command may record, given the run as it stands. Pure: a command
// reads the run inside its write transaction, decides here, then appends.
import { Option, Result, Schema } from "effect"
import { Event, ReviewVerdict, VerifyVerdict } from "./event.js"
import type { Agent, Role } from "./event.js"
import { agentOf, isOpen, openTracks } from "./state.js"
import type { Run, Seat, Track } from "./state.js"

/** A command the run's state does not allow; `reason` says what would. */
export class Refused extends Schema.TaggedError<Refused>()("Refused", { reason: Schema.String }) {
  override get message(): string {
    return this.reason
  }
}

const refuse = (reason: string): Result.Result<never, Refused> =>
  Result.fail(Refused.make({ reason }))

/** herdr agent names are at most 32 characters: `<run>-<unit>-impl`. */
const UNIT = /^[a-z][a-z0-9-]*$/
const NAME_LIMIT = 32

export type Opening = {
  readonly unit: string
  readonly cwd: string
  readonly tab: string
  readonly spec: string
  readonly impl: Agent
  readonly rev: Agent
  readonly ver: Option.Option<Agent>
  readonly maxFailures: number
}

/**
 * Checks a unit before any agent starts for it. One workspace per track: two
 * implementors in one tree commit each other's work.
 */
export const canOpen = (run: Run, unit: string, cwd: string): Result.Result<void, Refused> => {
  if (!UNIT.test(unit)) return refuse(`unit "${unit}" must match ${UNIT.source}`)
  if (`${run.name}-${unit}-impl`.length > NAME_LIMIT)
    return refuse(
      `"${run.name}-${unit}-impl" is longer than ${NAME_LIMIT} characters: shorten the unit`,
    )
  if (Option.exists(Option.fromUndefinedOr(run.tracks.get(unit)), isOpen))
    return refuse(`track ${run.name}-${unit} is already open`)
  for (const track of openTracks(run))
    if (track.cwd === cwd)
      return refuse(
        `track ${track.name} already works in ${cwd}: give each track its own workspace`,
      )
  return Result.void
}

export const open = (run: Run, opening: Opening): Result.Result<Event, Refused> =>
  Result.map(canOpen(run, opening.unit, opening.cwd), () => Event.cases.TrackOpened.make(opening))

/** The holder's seat passes the baton: what it hands on depends on its role. */
export type Pass = {
  readonly file: string
  readonly verdict: Option.Option<string>
  /** The implementor's commit, read by the caller from the track's checkout. */
  readonly head: Option.Option<string>
}

export const pass = (seat: Seat, input: Pass): Result.Result<Event, Refused> =>
  Result.flatMap(holds(seat), () => handOn(seat, input))

const handOn = (seat: Seat, input: Pass): Result.Result<Event, Refused> => {
  const { track, role } = seat
  const unit = track.unit
  if (role === "impl") {
    if (Option.isSome(input.verdict))
      return refuse("the implementor passes a round without a verdict: baton pass <request file>")
    return Option.match(input.head, {
      onNone: () => refuse(`no commit at ${track.cwd}: commit the round first`),
      onSome: (head) =>
        Result.succeed(Event.cases.RoundSubmitted.make({ unit, request: input.file, head })),
    })
  }
  if (role === "rev")
    return Result.map(verdictOf(ReviewVerdict, input.verdict), (verdict) =>
      Event.cases.ReviewFiled.make({ unit, verdict, findings: input.file }),
    )
  return Result.map(verdictOf(VerifyVerdict, input.verdict), (verdict) =>
    Event.cases.VerificationFiled.make({ unit, verdict, report: input.file }),
  )
}

const verdictOf = <A extends string>(
  schema: Schema.Codec<A>,
  verdict: Option.Option<string>,
): Result.Result<A, Refused> => {
  const choices = Schema.is(schema)
  return Option.match(verdict, {
    onNone: () => refuse("pass a verdict: --verdict <verdict>"),
    onSome: (value) => {
      if (choices(value)) return Result.succeed(value)
      return refuse(`"${value}" is not a verdict here`)
    },
  })
}

/** A worker asks the orchestrator for a decision; it holds the baton to ask. */
export const ask = (seat: Seat, note: string): Result.Result<Event, Refused> =>
  Result.map(holds(seat), () =>
    Event.cases.QuestionAsked.make({ unit: seat.track.unit, by: seat.role, note }),
  )

const holds = (seat: Seat): Result.Result<void, Refused> => {
  const { holder } = seat.track.step
  if (holder === seat.role) return Result.void
  return refuse(`the baton is with the ${holder} (${seat.track.step.kind}); end your turn`)
}

/** The orchestrator hands a worker a note, and with it the baton. */
export const tell = (
  run: Run,
  unit: string,
  to: Role,
  text: string,
): Result.Result<Event, Refused> =>
  Result.flatMap(openTrack(run, unit), (track) => {
    if (Option.isNone(agentOf(track, to))) return refuse(`track ${track.name} has no ${to}`)
    return Result.succeed(Event.cases.NoteSent.make({ unit, to, text }))
  })

export const close = (
  run: Run,
  unit: string,
  merged: Option.Option<string>,
): Result.Result<Event, Refused> =>
  Result.map(openTrack(run, unit), () => Event.cases.TrackClosed.make({ unit, merged }))

export const openTrack = (run: Run, unit: string): Result.Result<Track, Refused> => {
  const track = Option.filter(Option.fromUndefinedOr(run.tracks.get(unit)), isOpen)
  return Option.match(track, {
    onNone: () => refuse(`no open track ${run.name}-${unit}`),
    onSome: (found) => Result.succeed(found),
  })
}

/** A failed message goes out again; only a failed one. */
export const redeliver = (run: Run, ref: number): Result.Result<Event, Refused> => {
  const message = Option.fromUndefinedOr(run.messages.get(ref))
  if (!Option.exists(message, (found) => found.delivery.state === "failed"))
    return refuse(`message #${ref} has not failed`)
  return Result.succeed(Event.cases.RedeliveryRequested.make({ ref }))
}

/** Run names stay short and dash-free: they lead every agent name. */
const RUN = /^[a-z][a-z0-9]{0,7}$/

/** An orchestrator takes a run: a new one, or a live one it resumes. */
export const start = (
  name: string,
  existing: Option.Option<Run>,
  root: string,
  orchestrator: Agent,
): Result.Result<Event, Refused> => {
  if (!RUN.test(name)) return refuse(`run "${name}" must match ${RUN.source}`)
  if (Option.exists(existing, (run) => Option.isSome(run.ended)))
    return refuse(`run ${name} has ended; start another name`)
  const kept = Option.match(existing, { onNone: () => root, onSome: (run) => run.root })
  return Result.succeed(Event.cases.RunStarted.make({ root: kept, orchestrator }))
}

/** Ends a run, closing what it left open. */
export const end = (run: Run): ReadonlyArray<Event> => [
  ...openTracks(run).map((track) =>
    Event.cases.TrackClosed.make({ unit: track.unit, merged: Option.none() }),
  ),
  Event.cases.RunEnded.make({}),
]
