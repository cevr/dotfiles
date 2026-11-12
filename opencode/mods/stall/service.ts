// The contracts the stall watchdog needs from outside: the process's CPU
// profiler, the files captures are kept in, and the process's memory. Each
// operation states its failure; `laws.ts` states what the capture store owes.
import { Context, type Effect, Schema } from "effect"

/** The profiler would not start, stop or answer. */
export class ProfilerFailed extends Schema.TaggedError<ProfilerFailed>()("ProfilerFailed", {
  step: Schema.String,
  message: Schema.String,
}) {}

/** A capture could not be written, listed or pruned. */
export class CaptureFailed extends Schema.TaggedError<CaptureFailed>()("CaptureFailed", {
  path: Schema.String,
  message: Schema.String,
}) {}

/**
 * The process's own CPU profiler. One window samples at a time: `start` begins
 * one, `stop` ends it and answers its profile (a `.cpuprofile` document, the
 * Chrome DevTools format), and `discard` ends it unread.
 */
export class Profiler extends Context.Service<
  Profiler,
  {
    readonly start: Effect.Effect<void, ProfilerFailed>
    readonly stop: Effect.Effect<string, ProfilerFailed>
    readonly discard: Effect.Effect<void, ProfilerFailed>
  }
>()("dotfiles-opencode/stall/Profiler") {}

/** The process's memory, in bytes. */
export const Usage = Schema.Struct({ rss: Schema.Finite, heapUsed: Schema.Finite, heapTotal: Schema.Finite, external: Schema.Finite })
export interface Usage extends Schema.Schema.Type<typeof Usage> {}

/** The process's memory now. */
export class Memory extends Context.Service<
  Memory,
  {
    readonly rss: Effect.Effect<number>
    readonly usage: Effect.Effect<Usage>
  }
>()("dotfiles-opencode/stall/Memory") {}

/**
 * What a capture's summary says beside its profile: the stall (its wall-clock
 * time, lag and the RSS on each side of it), the process, the memory when the
 * capture's window ended, and the settings it ran with.
 */
export const Summary = Schema.Struct({
  stall: Schema.Struct({ at: Schema.Finite, lagMs: Schema.Finite, rssBefore: Schema.Finite, rssAfter: Schema.Finite }),
  pid: Schema.Finite,
  end: Usage,
  settings: Schema.Struct({ thresholdMs: Schema.Finite, captureMs: Schema.Finite, windowMs: Schema.Finite }),
})
export interface Summary extends Schema.Schema.Type<typeof Summary> {}

/**
 * Where captures are kept: each is a profile and its summary under one stem.
 * `write` answers the profile's path; `names` lists the files kept; `remove`
 * deletes the named ones.
 */
export class Captures extends Context.Service<
  Captures,
  {
    readonly write: (stem: string, profile: string, summary: Summary) => Effect.Effect<string, CaptureFailed>
    readonly names: Effect.Effect<ReadonlyArray<string>, CaptureFailed>
    readonly remove: (names: ReadonlyArray<string>) => Effect.Effect<void, CaptureFailed>
  }
>()("dotfiles-opencode/stall/Captures") {}
