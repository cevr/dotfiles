// A second writer's durable commit at the send boundary. All gating and
// the provider-facing binding still come from the production composition root.
import { Plugin } from "@opencode/plugin/effect"
import { Clock, Effect, Option, Predicate, Schema } from "effect"
import pool from "../../server.ts"
import { sendCost } from "../../../../tests/pool-openai-send/cost.ts"

const settings = Schema.decodeUnknownEffect(Schema.Struct({
  fixtureKind: Schema.optionalKey(Schema.Literal("signin")),
}))
const commitInput = Schema.Struct({ lastsMs: Schema.Finite.check(Schema.isGreaterThan(0)) })
const writer = {
  id: "fixture.openai-send-hold",
  methods: {
    commit: { input: Schema.toStandardSchemaV1(commitInput), output: { type: "object" } },
    read: { input: { type: "object" }, output: { type: "object" } },
    cost: { input: { type: "object" }, output: { type: "object" } },
  }, events: {},
} as const

export default Plugin.define({
  id: pool.id,
  effect: Effect.fn("OpenAISendFixture")(function* (ctx) {
    const { fixtureKind } = yield* settings(ctx.options).pipe(Effect.orDie)
    let fact = Option.none<{ readonly held: true; readonly until: number }>()
    type Event = { readonly sessionID: string; readonly kind: string; readonly model: { readonly providerID: string; readonly id: string };
      readonly step: { readonly id: string }; readonly frame: string }
    type Send = (event: Event) => Effect.Effect<void>
    // The benchmark invokes only the two registered final hooks, using the
    // common fields of their event contracts on both forks.
    const sendOf = Schema.decodeUnknownSync(Schema.declare<Send>((callback): callback is Send => Predicate.isFunction(callback)))
    const sends = new Map<string, Send>()
    const hook: typeof ctx.session.hook = (name, callback, options) => {
      if (name === "http.request" || name === "experimental.ws.send")
        sends.set(name, sendOf(callback))
      return ctx.session.hook(name, callback, options)
    }
    yield* ctx.rpc.register(writer, {
      commit: ({ lastsMs }) => Effect.gen(function* () {
        const selected = Option.fromUndefinedOr(yield* ctx.integration.connection.active("openai"))
        if (Option.isNone(selected) || selected.value.type !== "credential") return { held: false }
        const at = yield* Clock.currentTimeMillis
        const until = Math.ceil((at + lastsMs) / 1_000) * 1_000
        const kind = Option.getOrElse(Option.fromUndefinedOr(fixtureKind), () => "rate-limit" as const)
        yield* ctx.storage.set(`openai/hold/${selected.value.id}`, { kind, at, until })
        const committed = { held: true as const, until }
        fact = Option.some(committed)
        return committed
      }),
      read: () => Effect.sync(() => Option.getOrElse(fact, () => ({ held: false }))),
      cost: () => {
        return sendCost((transport, { sessionID, stepID, tracked, frame }) => {
          const name = { http: "http.request", websocket: "experimental.ws.send" }[transport]
          const send = Option.fromUndefinedOr(sends.get(name))
          if (Option.isNone(send)) return Effect.die(new Error(`Missing ${transport} hook`))
          const providerID = Option.getOrElse(Option.filter(Option.some("openai"), () => tracked), () => "untracked")
          return send.value({ sessionID, kind: "primary", step: { id: stepID }, frame,
            model: { providerID, id: "gpt-6.2-fixture" } })
        })
      },
    }).pipe(Effect.orDie)
    yield* pool.effect({ ...ctx, session: { ...ctx.session, hook } })
  }),
})
