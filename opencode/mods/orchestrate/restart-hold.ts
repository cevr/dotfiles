// A turn the server resumed after a restart inside the Sabbath rest waits for
// the rest to end. The update never restarts the server in the rest (mods/update
// gate.ts), but a crash or a restart by hand does, and the fork then resumes
// every turn the old process left running (its session/execution/restart.ts:
// a synthetic notice marked `notice: "restart"`, then the turn runs on). So
// the plugin holds each model request of such a turn until `rest(now).end`,
// the window the update's gate and the subagent latch use (sabbath.ts). A
// turn resumed before the rest, or one a prompt started, runs as always.
import { DateTime, Option, Predicate, Schema } from "effect"
import { type Place, rest } from "./sabbath.ts"

/** The fork's mark on the notice that resumes a turn after a server restart (`prepareResume`'s `metadata.notice`). */
export const RESTART_NOTICE = "restart"

/** A message's time as the host hands it: a DateTime, epoch ms, or an ISO string. */
const Created = Schema.Union([Schema.Finite, Schema.String, Schema.declare(DateTime.isDateTime)])

/** The notice that resumed a turn after a restart, with when it was written. */
const RestartNotice = Schema.Struct({
  type: Schema.Literal("synthetic"),
  metadata: Schema.Struct({ notice: Schema.Literal(RESTART_NOTICE) }),
  time: Schema.Struct({ created: Created }),
})
const decodeNotice = Schema.decodeUnknownOption(RestartNotice)

/** The marker of a turn's end: every message after the newest one belongs to the turn running now. */
const Idle = Schema.Struct({ type: Schema.Literal("idle") })
const isIdle = Schema.is(Idle)

/** A message's time in epoch ms; none for a string that is no time. */
const millisOf = (created: typeof Created.Type): Option.Option<number> =>
  Option.liftPredicate(created, DateTime.isDateTime).pipe(
    Option.map(DateTime.toEpochMillis),
    Option.orElse(() => Option.liftPredicate(created, Predicate.isNumber)),
    Option.orElse(() => Option.liftPredicate(created, Predicate.isString).pipe(Option.map(Date.parse), Option.filter(Number.isFinite))),
  )

/**
 * When the session's running turn may make its next model request: the rest's end, when `now` falls in the rest and
 * the turn (its messages since the last `idle`) was resumed by a restart notice written within this rest. None
 * otherwise: outside the rest, or a turn that no restart in the rest resumed, asks at once.
 */
export const heldUntil = (messages: ReadonlyArray<unknown>, now: number, place: Place): Option.Option<number> => {
  const window = rest(now, place)
  if (!window.on) return Option.none()
  const turn = messages.slice(messages.findLastIndex(isIdle) + 1)
  const resumedInRest = turn.some((message) =>
    Option.exists(
      Option.flatMap(decodeNotice(message), (notice) => millisOf(notice.time.created)),
      (created) => created >= window.start,
    ),
  )
  return Option.liftPredicate(window.end, () => resumedInRest)
}
