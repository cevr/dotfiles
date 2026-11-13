// The law probe: a server plugin that runs every host law (host-laws.ts)
// from inside the host it is loaded into, on the context that host gave it,
// and logs each law's outcome: `sim-law: kept <name>`, `sim-law: broken
// <name>: <why>`, then `sim-law: done`. The world loads it in
// sim/host-laws.test.ts; real OpenCode loads it from config, as the owner
// loads any plugin, in tests/host-laws.test.ts (sim/real.ts). It runs the laws
// only in its copy for the law folder: a host may load it for other folders.
import { Plugin } from "@opencode/plugin/effect"
import { Cause, Effect, Exit, Option } from "effect"
import { LAW_FOLDER, LAWS, LawBroken, probeOf } from "./host-laws.ts"
import { BROKEN, DONE, KEPT } from "./law-names.ts"

/** Why a law broke: its own words, or the host's failure in full. */
const why = <E>(cause: Cause.Cause<E>) => {
  const found = Cause.findErrorOption(cause)
  if (Option.isSome(found) && found.value instanceof LawBroken) return found.value.message
  return Cause.pretty(cause).split("\n").slice(0, 6).join(" | ")
}

export default Plugin.define({
  id: "dotfiles-opencode.sim-law",
  effect: (ctx) =>
    Effect.gen(function* () {
      if (!ctx.location.directory.endsWith(`/${LAW_FOLDER}`)) return
      const probe = yield* probeOf(ctx)
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          for (const law of LAWS) {
            const exit = yield* Effect.exit(Effect.scoped(law.check(ctx, probe)))
            if (Exit.isSuccess(exit)) yield* Effect.logInfo(`${KEPT}${law.name}`)
            else yield* Effect.logInfo(`${BROKEN}${law.name}: ${why(exit.cause)}`)
          }
          yield* Effect.logInfo(DONE)
        }),
      )
    }),
})
