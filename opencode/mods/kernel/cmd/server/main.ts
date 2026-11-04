/**
 * The code kernel as an OpenCode server plugin, ported from gent's `cell`
 * tool. The composition root: it decodes the options, builds the model
 * (kernel/model.ts) on one implementation of each contract in
 * kernel/service.ts, and registers the `kernel` tool with it.
 *
 * - `kernel({ code, reset? })` runs TypeScript in a Bun worker that lives as
 *   long as its session, so top-level bindings persist between calls. The
 *   result is what the code printed, then its last expression's value.
 * - Inside the code, `await tools.<id>(input)` runs another OpenCode tool
 *   (opencode/toolbox.ts).
 * - One worker per session, started on the first call. It is killed when the
 *   session is deleted, after `idleMs` without a call, on abort, and past the
 *   compute limit. After every call the bindings that hold data are stored
 *   under the session as structured clones (worker/codec.ts); a new
 *   worker starts with them, and `reset` drops them.
 * - With `codeOnly` (the default) the kernel is the agent's runtime, as Prime
 *   Agent's REPL is: the model is offered the kernel alone, its description
 *   lists every other tool with its input, and a cell's call runs through the
 *   registry's hooks, so `tools.subagent` passes the orchestrate guard, pace
 *   and Sabbath. Deny `kernel` to an agent to give it its usual tools. Needs
 *   the fork's `options.runtime`.
 * - Without `codeOnly` it is a direct tool beside the others (`codemode:
 *   false`), whose calls skip the hooks; with `denyExecute`, every agent the
 *   plugins define denies code mode's `execute`.
 *
 * Options (all optional; an absent one takes its default, a malformed one stops the plugin):
 * - `idleMs`: kill a session's worker after this long without a call; default 1,800,000 (30 min).
 * - `timeoutMs`: a call's compute limit, paused while its tool calls run; default 30,000.
 * - `viewChars`: the characters of output the model sees per call; default 8,000.
 * - `codeOnly`: make the kernel the agents' only tool; default true.
 * - `denyExecute`: without `codeOnly`, deny code mode's `execute` to every agent; default true.
 */
import { Plugin, Tool } from "@opencode/plugin/effect"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { description, KernelInput } from "../../kernel/description.ts"
import * as Model from "../../kernel/model.ts"
import type { Sessions, Snapshots, Workers } from "../../kernel/service.ts"
import { KernelSessionId } from "../../kernel/session.ts"
import * as OpenCodeSessions from "../../opencode/sessions.ts"
import * as OpenCodeSnapshots from "../../opencode/snapshots.ts"
import * as OpenCodeToolbox from "../../opencode/toolbox.ts"
import * as ProcessWorkers from "../../worker/workers.ts"

/**
 * An option that takes `fallback` when absent. A present value must decode.
 * `undefined` counts as absent: a host passing options in-process leaves an
 * unset one undefined, and a JSON config cannot write it.
 */
const withDefault =
  <A>(fallback: A) =>
  <S extends Schema.Codec<A, any, never, never>>(schema: S) =>
    schema.pipe(Schema.withDecodingDefaultType(Effect.succeed(fallback)))

/** A count of milliseconds or characters: finite and above zero. */
const Positive = Schema.Finite.check(Schema.isGreaterThan(0))

export const Options = Schema.Struct({
  idleMs: Positive.pipe(withDefault(30 * 60_000)),
  timeoutMs: Positive.pipe(withDefault(30_000)),
  viewChars: Positive.pipe(withDefault(8_000)),
  codeOnly: Schema.Boolean.pipe(withDefault(true)),
  denyExecute: Schema.Boolean.pipe(withDefault(true)),
})
export type Options = typeof Options.Type

/** The contracts the model runs on, built once; a call's tools come with the call. */
export type Contracts = Workers | Snapshots | Sessions

/** One implementation of each contract, as OpenCode and Bun provide them. */
export const live = (ctx: Plugin.Context, options: Options): Layer.Layer<Contracts> =>
  Layer.mergeAll(
    ProcessWorkers.layer({ timeoutMs: options.timeoutMs }),
    OpenCodeSnapshots.layer(ctx.storage),
    OpenCodeSessions.fromContext(ctx),
  )

/** The plugin on `externals`: OpenCode and Bun in production, memory and test Layers in the seam test. */
export const make = (externals: (ctx: Plugin.Context, options: Options) => Layer.Layer<Contracts>) =>
  Plugin.define({
    id: "dotfiles-opencode.kernel",
    effect: Effect.fn("Kernel.plugin")(function* (ctx) {
      // A malformed option is a mistake in the config: the plugin does not start, and says which.
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(
        Effect.mapError((error) => new Error(`dotfiles-opencode.kernel: invalid options: ${error.message}`)),
        Effect.orDie,
      )
      const services = yield* Layer.build(
        Model.layer({ idleMs: options.idleMs, viewChars: options.viewChars }).pipe(Layer.provideMerge(externals(ctx, options))),
      )
      const kernel = Context.get(services, Model.Kernel)

      yield* ctx.tool.transform((editor) => {
        editor.add({
          name: "kernel",
          description: description(options),
          input: KernelInput,
          options: options.codeOnly
            ? { codemode: false, runtime: { describe: (tools) => description(options, tools) } }
            : { codemode: false },
          execute: (input, context) =>
            kernel
              .run({ session: KernelSessionId.make(context.sessionID), agent: context.agent, code: input.code, reset: input.reset === true })
              .pipe(
                Effect.provide(OpenCodeToolbox.forCall(ctx, context)),
                Effect.mapError((unreadable) => new Tool.Error({ message: unreadable.message, error: unreadable })),
                Effect.flatMap((answer) => (answer.ok ? Effect.succeed({ content: answer.text }) : Effect.fail(new Tool.Error({ message: answer.text })))),
              ),
        })
      })

      if (!options.codeOnly && options.denyExecute)
        yield* ctx.agent.transform((editor) => {
          for (const agent of editor.list())
            editor.update(agent.id, (item) => {
              item.permissions.push({ action: "execute", resource: "*", effect: "deny" })
            })
        })

      // A deleted session's worker stops and its stored bindings go.
      yield* Effect.forkScoped(
        ctx.event.subscribe({ types: ["session.deleted"] }).pipe(
          Stream.runForEach((event) => kernel.deleted(KernelSessionId.make(event.data.sessionID)).pipe(Effect.ignoreCause)),
          Effect.ignoreCause,
        ),
      )
    }),
  })

export default make(live)
