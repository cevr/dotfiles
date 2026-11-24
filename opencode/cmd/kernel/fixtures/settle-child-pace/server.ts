// A provider-neutral pace oracle for the pinned Kernel + Orchestrate + Wake test.
// This directory is loaded only in the fixture's scratch config.
import { Plugin, Tool } from "@opencode/plugin/effect"
import { Effect, Option, Schema } from "effect"
import { POOL_STATUS } from "../../../../mods/pool/status.ts"

const Pace = { ...POOL_STATUS, methods: { pace: POOL_STATUS.methods.pace, started: POOL_STATUS.methods.started } }
const Ask = Schema.Struct({ sessionID: Schema.String.check(Schema.isStartingWith("ses")).pipe(Schema.brand("SessionID")) })
const decodeAsk = Schema.decodeUnknownOption(Ask)
const Options = Schema.Struct({ opensAt: Schema.Number })
const Suppress = Schema.Struct({ child: Ask.fields.sessionID, shellID: Schema.String })
const reject = (message: string) => new Tool.Error({ message })

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
          // Orchestrate reads its clock before asking pace; cross that tick
          // before Wake receives the ask, making its floor strictly later.
          yield* Effect.sleep("10 millis")
          return { ok: false, measured: true, reason: "fixture hold", retryAt: 0 }
        }
        if (Option.exists(owner, ({ title }) => title === "Fixture distant hold")) {
          return { ok: false, measured: true, reason: "fixture hold", retryAt: opensAt }
        }
        return { ok: true, measured: true }
      }),
      started: () => Effect.succeed({}),
    }).pipe(Effect.orDie)
    yield* ctx.tool.transform((edit) => edit.add({
      name: "fixture_shell_suppress",
      description: "Run the scratch shell's own kill action without starting a new child execution.",
      input: Suppress,
      options: { codemode: false },
      execute: Effect.fn("LifecycleFixture.Suppress")(function* (request, parent) {
        const child = yield* ctx.session.get({ sessionID: request.child }).pipe(Effect.mapError(() => reject("no scratch child")))
        if (child.parentID !== parent.sessionID) return yield* reject("not the scratch parent")
        const tools = yield* ctx.tool.list()
        const shell = tools.find((tool) => tool.name === "shell")
        if (!shell) return yield* reject("native shell is not installed")
        // The real shell's act branch checks the target ID against the
        // supplied child's ownership and records its native "answered" mark.
        const result = yield* shell.execute({ action: "kill", id: request.shellID }, { ...parent, sessionID: request.child })
        return { content: result.content }
      }),
    })).pipe(Effect.orDie)
  }),
})
