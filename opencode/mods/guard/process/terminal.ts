import { Deferred, Effect, Option, Queue, Scope } from "effect"
import { AdmissionUnavailable } from "../admission.ts"
import type { BootHost } from "./admission.ts"
import { issue, type Actuation } from "./actuation.ts"

const unqualified = () => new AdmissionUnavailable({ reason: "unqualified" })

// SIGINT already reached the payload via the TTY. Do not issue TERM before
// this grace ends. A still-running payload then takes the normal watchdog
// TERM → KILL path, never a second SIGINT.
export const INTERRUPT_GRACE_MS = 4000
export type ForegroundInterrupt = () => boolean

// Capture the foreground before pinOf makes this process a private leader.
// In a job-control shell that already made us the leader, the shell itself
// restores foreground after waitpid reports our stop/exit.
export const foregroundOf = (host: BootHost) => {
  const sys = host.kernel.core.symbols
  if (Option.isNone(host.kernel.mach) || sys.isatty(0) !== 1) return Option.none<number>()
  const group = host.kernel.mach.value.symbols.tcgetpgrp(0)
  if (group <= 0 || group !== sys.getpgrp()) return Option.none<number>()
  return Option.some(group)
}

export const foregroundScope = Effect.fn("LaunchScope.foreground")(function* (
  host: BootHost, callerGroup: Option.Option<number>, jobState: (paused: boolean) => Effect.Effect<void, AdmissionUnavailable>,
  onInterrupt: (handler: Option.Option<ForegroundInterrupt>) => void,
  interrupt: Deferred.Deferred<void>, beforeResume: Effect.Effect<void> = Effect.void,
): Effect.fn.Return<Effect.Effect<never, AdmissionUnavailable>, AdmissionUnavailable, Scope.Scope> {
  if (Option.isNone(callerGroup) || Option.isNone(host.kernel.mach)) return Effect.never
  const tty = host.kernel.mach.value.symbols
  const sys = host.kernel.core.symbols
  const own = sys.getpid()
  if (own !== sys.getpgrp()) return yield* unqualified()
  const caller = callerGroup.value
  const set = (next: number) => {
    // POSIX requires blocking SIGTTOU when tcsetpgrp runs from a background
    // group. Restore the calling thread's mask before any exec or await.
    const mask = new Uint32Array([1 << (22 - 1)])
    const prior = new Uint32Array(1)
    if (tty.sigprocmask(1, mask, prior) !== 0) return false
    const result = tty.tcsetpgrp(0, next)
    const restored = tty.sigprocmask(3, prior, mask)
    return result === 0 && restored === 0
  }
  const take = () => {
    const current = tty.tcgetpgrp(0)
    if (current !== own && (current !== caller || !set(own))) return false
    return true
  }
  const restore = () => {
    if (caller !== own && tty.tcgetpgrp(0) === own) set(caller)
  }
  const handleInterrupt = () => {
    // `fg` in the parent can restore tty ownership and wake the child
    // before this process handles SIGCONT. The cached pause bit is not
    // evidence that SIGINT was not delivered to this owned foreground.
    if (sys.getpgrp() !== own || tty.tcgetpgrp(0) !== own) return false
    Deferred.doneUnsafe(interrupt, Effect.void)
    return true
  }
  const port: Actuation<AdmissionUnavailable> = {
    dispatch: (intent) => Effect.suspend(() => {
      if (sys.getpgrp() !== own) return Effect.fail(unqualified())
      if (intent.target === "self" && tty.kill(own, 17) === 0) return Effect.void
      if (intent.target === "own-group" && intent.signal === "CONT" && tty.kill(0, 19) === 0) return Effect.void
      return Effect.fail(unqualified())
    }),
  }
  const inputs = yield* Queue.unbounded<"stop" | "continue">()
  const stop = () => { Queue.offerUnsafe(inputs, "stop") }
  const resume = () => { Queue.offerUnsafe(inputs, "continue") }
  yield* Effect.acquireRelease(Effect.sync(() => {
    process.on("SIGTSTP", stop)
    process.on("SIGCONT", resume)
    onInterrupt(Option.some(handleInterrupt))
  }), () => Effect.sync(() => {
    process.off("SIGTSTP", stop)
    process.off("SIGCONT", resume)
    onInterrupt(Option.none())
    restore()
  }))
  if (!take()) return yield* unqualified()
  return Effect.gen(function* () {
    let paused = false
    for (;;) {
      const signal = yield* Queue.take(inputs)
      if (signal === "stop" && !paused) {
        yield* jobState(true)
        paused = true
        restore()
        yield* issue(port, [{ target: "self", signal: "STOP" }])
      } else if (signal === "continue" && paused) {
        yield* beforeResume
        if (!take()) continue
        yield* issue(port, [{ target: "own-group", signal: "CONT" }])
        yield* jobState(false)
        paused = false
      }
    }
  })
})
