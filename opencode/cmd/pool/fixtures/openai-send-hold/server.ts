// A second writer's durable commit at the socket boundary. All gating and
// the provider-facing binding still come from the production composition root.
import { Plugin } from "@opencode/plugin/effect"
import { Clock, Effect, Option, Schema } from "effect"
import pool from "../../server.ts"

const settings = Schema.decodeUnknownEffect(Schema.Struct({ fixtureHold: Schema.Finite }))
const writer = {
  id: "fixture.openai-send-hold",
  methods: {
    commit: { input: { type: "object" }, output: { type: "object" } },
    read: { input: { type: "object" }, output: { type: "object" } },
  }, events: {},
} as const

export default Plugin.define({
  id: pool.id,
  effect: Effect.fn("OpenAISendFixture")(function* (ctx) {
    const { fixtureHold: until } = yield* settings(ctx.options).pipe(Effect.orDie)
    let fact = Option.none<{ readonly held: true; readonly until: number }>()
    yield* ctx.rpc.register(writer, {
      commit: () => Effect.gen(function* () {
        const selected = Option.fromUndefinedOr(yield* ctx.integration.connection.active("openai"))
        if (Option.isNone(selected) || selected.value.type !== "credential") return { held: false }
        const at = yield* Clock.currentTimeMillis
        if (at >= until) return { held: false }
        yield* ctx.storage.set(`openai/hold/${selected.value.id}`, { kind: "rate-limit", at, until })
        const committed = { held: true as const, until }
        fact = Option.some(committed)
        return committed
      }),
      read: () => Effect.sync(() => Option.getOrElse(fact, () => ({ held: false }))),
    }).pipe(Effect.orDie)
    yield* pool.effect(ctx)
  }),
})
