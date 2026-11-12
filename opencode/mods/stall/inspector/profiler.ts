// The Profiler over the runtime's own inspector (`node:inspector`, in process),
// the same session the binary's SIGPROF profile uses
// (packages/cli/src/cpu-profile.ts in the fork). One session per layer: it is
// connected and the profiler enabled at the sampling interval when the layer
// is built, and disconnected when its scope closes. Bun's sampler takes a
// sample only while JavaScript runs, so a window over an idle server stays
// empty.
import { Session } from "node:inspector"
import { Effect, Layer, Schema } from "effect"
import { Profiler, ProfilerFailed } from "../service.ts"

type Method = "Profiler.enable" | "Profiler.setSamplingInterval" | "Profiler.start" | "Profiler.stop"

interface Params {
  readonly interval?: number
}

/** What `Profiler.stop` answers, as far as the watchdog reads it. */
const Stopped = Schema.Struct({ profile: Schema.Unknown })
const decodeStopped = Schema.decodeUnknownEffect(Stopped)
const encodeProfile = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

/** One inspector call; its answer is left unread. */
const post = (session: Session, method: Method, params: Params) =>
  Effect.callback<unknown, ProfilerFailed>((resume) => {
    session.post(method, params, (error, answer) => {
      if (error) return resume(Effect.fail(new ProfilerFailed({ step: method, message: error.message })))
      resume(Effect.succeed(answer))
    })
  })

/** The profile `Profiler.stop` answered, as a `.cpuprofile` document. */
const stopped = (session: Session) =>
  post(session, "Profiler.stop", {}).pipe(
    Effect.flatMap((answer) =>
      decodeStopped(answer).pipe(
        Effect.flatMap((read) => encodeProfile(read.profile)),
        Effect.mapError((error) => new ProfilerFailed({ step: "Profiler.stop", message: error.message })),
      ),
    ),
  )

/** The profiler sampling every `intervalUs` microseconds. */
export const layer = (intervalUs: number) =>
  Layer.effect(
    Profiler,
    Effect.gen(function* () {
      const session = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const opened = new Session()
          opened.connect()
          return opened
        }),
        (opened) => Effect.sync(() => opened.disconnect()),
      )
      yield* post(session, "Profiler.enable", {})
      yield* post(session, "Profiler.setSamplingInterval", { interval: intervalUs })
      return Profiler.of({
        start: Effect.asVoid(post(session, "Profiler.start", {})),
        stop: stopped(session),
        discard: Effect.asVoid(post(session, "Profiler.stop", {})),
      })
    }),
  )
