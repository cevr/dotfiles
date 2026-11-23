// A provider-neutral pace oracle for the pinned Kernel + Orchestrate + Wake test.
// This directory is loaded only in the fixture's scratch config.
import { Plugin } from "@opencode/plugin/effect"
import { Effect, Option, Schema } from "effect"
import { POOL_STATUS } from "../../../../mods/pool/status.ts"

const Pace = { ...POOL_STATUS, methods: { pace: POOL_STATUS.methods.pace, started: POOL_STATUS.methods.started } }
const Ask = Schema.Struct({ sessionID: Schema.String.check(Schema.isStartingWith("ses")).pipe(Schema.brand("SessionID")) })
const decodeAsk = Schema.decodeUnknownOption(Ask)
const Options = Schema.Struct({ opensAt: Schema.Number })

export default Plugin.define({
  id: "fixture.lifecycle-pace",
  effect: Effect.fn("LifecycleFixture.Pace")(function* (ctx) {
    const { opensAt } = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(Effect.orDie)
    yield* ctx.rpc.register(Pace, {
      pace: (input) => Effect.gen(function* () {
        const ask = decodeAsk(input)
        if (Option.isNone(ask)) return { ok: true, measured: true }
        const owner = yield* ctx.session.get(ask.value).pipe(Effect.option)
        if (Option.exists(owner, ({ title }) => title === "Fixture short hold")) {
          return { ok: false, measured: true, reason: "fixture hold", retryAt: 0 }
        }
        if (Option.exists(owner, ({ title }) => title === "Fixture distant hold")) {
          return { ok: false, measured: true, reason: "fixture hold", retryAt: opensAt }
        }
        return { ok: true, measured: true }
      }),
      started: () => Effect.succeed({}),
    }).pipe(Effect.orDie)
  }),
})
