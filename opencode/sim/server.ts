// The law probe: a server plugin that runs every host law (host-laws.ts)
// from inside the host it is loaded into, on the context that host gave it,
// and logs each law's outcome: `sim-law: kept <name>`, `sim-law: broken
// <name>: <why>`, then `sim-law: done`. A law has LAW_LIMIT_MS on the host's
// clock: past it the law breaks, naming the limit, and the next law runs. The world loads it in
// sim/host-laws.test.ts; real OpenCode loads it from config, as the owner
// loads any plugin, in tests/host-laws.test.ts (tests/host-laws/real.ts). It runs the laws
// only in its copy for the law folder: a host may load it for other folders.
import { Plugin } from "@opencode/plugin/effect"
import { Cause, Effect, Exit, Option } from "effect"
import { type Law, LAWS, LawBroken, type Probe, probeOf } from "./host-laws.ts"
import { BROKEN, DONE, KEPT, LAW_FOLDER, LAW_LIMIT_MS } from "./law-names.ts"

/** Why a law broke: its own words, or the host's failure in full. */
const why = <E>(cause: Cause.Cause<E>) => {
  const found = Cause.findErrorOption(cause)
  if (Option.isSome(found) && found.value instanceof LawBroken) return found.value.message
  return Cause.pretty(cause).split("\n").slice(0, 6).join(" | ")
}

/**
 * Runs `laws` in order on `ctx`, logging each one's outcome, then `done`. A law past LAW_LIMIT_MS on the host's clock
 * breaks naming the limit, so a law that hangs names itself and the laws after it still run.
 */
export const runLaws = Effect.fn("SimLaw.runLaws")(function* (laws: ReadonlyArray<Law>, ctx: Plugin.Context, probe: Probe) {
  for (const law of laws) {
    const exit = yield* Effect.exit(Effect.scoped(law.check(ctx, probe)).pipe(Effect.timeoutOption(LAW_LIMIT_MS)))
    if (Exit.isFailure(exit)) yield* Effect.logInfo(`${BROKEN}${law.name}: ${why(exit.cause)}`)
    else if (Option.isNone(exit.value)) yield* Effect.logInfo(`${BROKEN}${law.name}: ran past its limit of ${LAW_LIMIT_MS / 1000} s on the host's clock`)
    else yield* Effect.logInfo(`${KEPT}${law.name}`)
  }
  yield* Effect.logInfo(DONE)
})

export default Plugin.define({
  id: "dotfiles-opencode.sim-law",
  effect: (ctx) =>
    Effect.gen(function* () {
      if (!ctx.location.directory.endsWith(`/${LAW_FOLDER}`)) return
      const probe = yield* probeOf(ctx)
      yield* Effect.forkScoped(runLaws(LAWS, ctx, probe))
    }),
})
