/**
 * Advisory `flock(2)` locks on files, shared across processes: the rift tool holds them around a
 * land's checks, and a repository's post-land step, a process of its own, takes them around the work
 * that must not overlap those checks (it reads their paths from `RIFT_LAND_CHECKS_LOCK` and
 * `RIFT_LAND_ACCEPT_LOCK`). The kernel owns each lock: it ends with its holder, a crash or a kill
 * included, so no lock goes stale. Taking one never blocks the event loop: it asks without waiting,
 * and asks again after a short pause until it holds it.
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { platform } from "node:os"
import { dirname } from "node:path"
import { pid } from "node:process"
import { dlopen, FFIType } from "bun:ffi"
import { Console, Data, DateTime, Effect, Match, Option, Schedule, Schema, type Scope } from "effect"
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

/**
 * The locks a full gate (`bun run gate` by hand) takes its turn by: `checks`, the lock a land's checks hold
 * shared, which the gate holds exclusively for its whole run, so one full gate runs on a host at a time and
 * never beside a land's check; and `wanted`, which a land's checks hold shared from before they wait for
 * `checks` until they end, so a waiting gate sees a land coming and lets it go first.
 */
export interface GateLocks {
  readonly checks: string
  readonly wanted: string
}

/** Who holds a full gate's turn, written beside the checks lock while it runs: its process, its checkout, since when. */
const GateHolder = Schema.Struct({ pid: Schema.Number, root: Schema.String, since: Schema.String })
const GateHolderJson = Schema.fromJsonString(GateHolder)
const decodeHolder = Schema.decodeUnknownOption(GateHolderJson)
const encodeHolder = Schema.encodeSync(GateHolderJson)

/** The file naming the gate that holds `checks`. */
const holderFile = (checks: string): string => `${checks}.gate.json`

/** How long a waiting gate pauses before it asks for its turn again. */
const GATE_PAUSE = "250 millis"

/** Whether no other holder has `file`: it could be taken exclusively at once (and is let go again). */
const free = (file: string) => Effect.map(holdingIfFree(file, Effect.void), Option.isSome)

/** The gate holding the checks lock, as its holder file says; none when there is no such file or it does not read. */
const gateHolder = (checks: string) =>
  Effect.try({ try: () => readFileSync(holderFile(checks), "utf8"), catch: () => "unreadable" }).pipe(Effect.option, Effect.map(Option.flatMap(decodeHolder)))

/** Why a gate waits, as the line it says: a land's check comes first, or the gate holding the lock, or another holder. */
const waitingLine = (locks: GateLocks) =>
  Effect.gen(function* () {
    if (!(yield* free(locks.wanted))) return "gate: waiting for the checks lock: a land's check holds it or wants it (a land goes first)"
    return Option.match(yield* gateHolder(locks.checks), {
      onNone: () => "gate: waiting for the checks lock: another holder has it (a land's check, or a fork move by bun run daily)",
      onSome: (holder) => `gate: waiting for the checks lock: the gate in ${holder.root} (pid ${holder.pid}) holds it since ${holder.since}`,
    })
  })

/** One try at the turn: `effect` run holding `checks` exclusively, when it is free and no land's check holds `wanted`; none at once, running nothing, else. */
const tryTurn = <A, E, R>(locks: GateLocks, root: string, effect: Effect.Effect<A, E, R>) =>
  holdingIfFree(
    locks.checks,
    Effect.gen(function* () {
      // A land that came while this gate waited holds `wanted` by now: this gate lets the lock go to it.
      if (!(yield* free(locks.wanted))) return Option.none<A>()
      const since = DateTime.formatIso(yield* DateTime.now)
      yield* Effect.sync(() => writeFileSync(holderFile(locks.checks), encodeHolder({ pid, root, since })))
      return Option.some(yield* Effect.ensuring(effect, Effect.sync(() => rmSync(holderFile(locks.checks), { force: true }))))
    }),
  ).pipe(Effect.map(Option.flatten))

/**
 * Runs `effect`, a full gate in `root`, in its turn: holding `locks.checks` exclusively for the whole run.
 * While another holder has it, or a land's check holds `locks.wanted`, it waits, saying why each time the
 * reason changes, and asks again every GATE_PAUSE; a land's check that comes while it waits goes first.
 */
export const gateTurn = <A, E, R>(locks: GateLocks, root: string, effect: Effect.Effect<A, E, R>, say: (line: string) => Effect.Effect<void>) => {
  const attempt = (told: string): Effect.Effect<A, E | RiftFailed, R> =>
    Effect.flatMap(
      tryTurn(locks, root, effect),
      Option.match({
        onSome: (value) => Effect.succeed(value),
        onNone: () =>
          waitingLine(locks).pipe(
            Effect.tap((line) => Effect.when(say(line), Effect.sync(() => line !== told))),
            Effect.tap(() => Effect.sleep(GATE_PAUSE)),
            Effect.flatMap(attempt),
          ),
      }),
    )
  return attempt("")
}

/**
 * For the gate script: runs `step`, a full gate in `root`, in its turn (`gateTurn`), saying why it waits on
 * stderr; as is when `landCheck` names the gate check a land runs it under, since that land holds the locks.
 */
export const oneGate =
  (locks: GateLocks, root: string, landCheck: Option.Option<string>) =>
  <A>(step: () => Promise<A>): Promise<A> =>
    Effect.runPromise(
      Option.match(Option.filter(landCheck, (label) => label === "gate"), {
        onSome: () => Effect.promise(step),
        onNone: () => gateTurn(locks, root, Effect.promise(step), (line) => Console.error(line)),
      }),
    )

/** Runs `effect` holding each lock of `locks`, taken in order. */
export const holding = <A, E, R>(locks: ReadonlyArray<readonly [string, LockMode]>, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | RiftFailed, R> =>
  Effect.scoped(Effect.andThen(Effect.forEach(locks, ([file, mode]) => hold(file, mode), { discard: true }), effect))
