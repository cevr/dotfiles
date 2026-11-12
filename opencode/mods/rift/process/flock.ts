/**
 * Advisory `flock(2)` locks on files, shared across processes: the rift tool holds them around a
 * land's checks, and a repository's post-land step, a process of its own, takes them around the work
 * that must not overlap those checks (it reads their paths from `RIFT_LAND_CHECKS_LOCK` and
 * `RIFT_LAND_ACCEPT_LOCK`). The kernel owns each lock: it ends with its holder, a crash or a kill
 * included, so no lock goes stale. Taking one never blocks the event loop: it asks without waiting,
 * and asks again after a short pause until it holds it.
 */
import { closeSync, mkdirSync, openSync } from "node:fs"
import { platform } from "node:os"
import { dirname } from "node:path"
import { dlopen, FFIType } from "bun:ffi"
import { Data, Effect, Match, Option, Schedule, type Scope } from "effect"
import { RiftFailed } from "../service.ts"

/** Many shared holders at once, or one exclusive holder alone. */
export type LockMode = "shared" | "exclusive"

/** `flock(2)`'s operations; the same numbers on macOS and Linux. */
const OPERATIONS: Readonly<Record<LockMode, number>> = { shared: 1, exclusive: 2 }
const NON_BLOCKING = 4

/** libc by platform: macOS's libSystem, else glibc's. */
const LIBC = Match.value(platform()).pipe(
  Match.when("darwin", () => "/usr/lib/libSystem.B.dylib"),
  Match.orElse(() => "libc.so.6"),
)

const flock = dlopen(LIBC, {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
}).symbols.flock

/** Another process holds the lock in a mode that excludes this one. */
class Taken extends Data.TaggedError("Taken")<{}> {}

/** How long a waiting holder pauses before it asks again, and how long it waits in all before it gives up. */
const PAUSE = "50 millis"
const PATIENCE = "3 hours"
const ATTEMPTS = (3 * 60 * 60 * 1000) / 50

/**
 * Holds the lock on `file` (made, with its folder, when missing) in `mode` for the rest of the scope,
 * waiting for it while another holder excludes it (for PATIENCE at most, then failing); closing the file
 * at the scope's end releases it.
 */
export const hold = (file: string, mode: LockMode): Effect.Effect<void, RiftFailed, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        mkdirSync(dirname(file), { recursive: true })
        return openSync(file, "a+")
      },
      catch: (cause) => new RiftFailed({ operation: "open lock", message: `${file}: ${String(cause)}` }),
    }),
    (descriptor) => Effect.sync(() => closeSync(descriptor)),
  ).pipe(
    Effect.flatMap((descriptor) =>
      Effect.sync(() => flock(descriptor, OPERATIONS[mode] | NON_BLOCKING)).pipe(
        Effect.filterOrFail(
          (code) => code === 0,
          () => new Taken(),
        ),
        Effect.retry({ schedule: Schedule.spaced(PAUSE), times: ATTEMPTS }),
        Effect.mapError(() => new RiftFailed({ operation: "flock", message: `${file} stayed held for ${PATIENCE}` })),
      ),
    ),
  )

/** The lock file a land named in `file`, none when it is empty (a run by hand). */
const named = (file: string): Option.Option<string> => Option.filter(Option.some(file), (path) => path !== "")

/**
 * For a script outside Effect (a repository's post-land step): runs `step`, a promise, holding the lock
 * on `file` exclusively, or as is when `file` is empty.
 */
export const exclusively =
  (file: string) =>
  <A>(step: () => Promise<A>): Promise<A> =>
    Effect.runPromise(
      Option.match(named(file), {
        onNone: () => Effect.promise(step),
        onSome: (path) => holding([[path, "exclusive"]], Effect.promise(step)),
      }),
    )

/**
 * For a script outside Effect: runs `step`, a synchronous one, holding the lock on `file` exclusively, or
 * as is when `file` is empty. It blocks its thread while it waits for the lock: a script's step has
 * nothing else to do meanwhile. A `lock` call that does not take it (libc's `flock`, interrupted or
 * handed a bad descriptor) fails with a RiftFailed and runs no step.
 */
export const exclusivelySync =
  (file: string, lock: (descriptor: number, operation: number) => number = flock) =>
  <A>(step: () => A): A =>
    Option.match(named(file), {
      onNone: step,
      onSome: (path) =>
        Effect.runSync(
          Effect.acquireUseRelease(
            Effect.sync(() => {
              mkdirSync(dirname(path), { recursive: true })
              return openSync(path, "a+")
            }),
            (descriptor) =>
              Effect.sync(() => lock(descriptor, OPERATIONS.exclusive)).pipe(
                Effect.filterOrFail(
                  (code) => code === 0,
                  (code) => new RiftFailed({ operation: "flock", message: `${path}: flock returned ${code}` }),
                ),
                Effect.andThen(Effect.sync(step)),
              ),
            (descriptor) => Effect.sync(() => closeSync(descriptor)),
          ),
        ),
    })

/**
 * Runs `effect` holding the lock on `file` exclusively when no other holder (another process, or another
 * open of it in this one) has it, answering its result; answers none at once, running nothing, when one has.
 */
export const holdingIfFree = <A, E, R>(file: string, effect: Effect.Effect<A, E, R>): Effect.Effect<Option.Option<A>, E | RiftFailed, R> =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.try({
        try: () => {
          mkdirSync(dirname(file), { recursive: true })
          return openSync(file, "a+")
        },
        catch: (cause) => new RiftFailed({ operation: "open lock", message: `${file}: ${String(cause)}` }),
      }),
      (descriptor) => Effect.sync(() => closeSync(descriptor)),
    ).pipe(
      Effect.flatMap((descriptor) => {
        if (flock(descriptor, OPERATIONS.exclusive | NON_BLOCKING) !== 0) return Effect.succeed(Option.none<A>())
        return Effect.map(effect, Option.some)
      }),
    ),
  )

/** Runs `effect` holding each lock of `locks`, taken in order. */
export const holding = <A, E, R>(locks: ReadonlyArray<readonly [string, LockMode]>, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | RiftFailed, R> =>
  Effect.scoped(Effect.andThen(Effect.forEach(locks, ([file, mode]) => hold(file, mode), { discard: true }), effect))
