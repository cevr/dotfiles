/**
 * The status mod's server half: an OpenCode server plugin answering the
 * status RPC (domain/Status.ts) the /pool pane reads. The composition root:
 * it decodes the options, builds the status model (domain/Status.model.ts) on
 * the call log and the runs (host/), and registers the RPC.
 *
 * Options (all optional; an absent one takes its default, a malformed one stops the plugin):
 * - `log`: orchestrate's call log, default `~/.cache/orchestrate/opencode-agents.jsonl`.
 * - `statusScript`: the orchestrate skill's status script, default
 *   `~/.claude/skills/orchestrate/scripts/status.ts`.
 */
import { Plugin } from "@opencode/plugin/effect"
import { homedir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import type { CallLog } from "./domain/Agents/CallLog.external.ts"
import type { RunTables } from "./domain/Runs/RunTables.external.ts"
import * as Model from "./domain/Status.model.ts"
import { STATUS } from "./domain/Status.ts"
import * as CallLogFile from "./host/CallLog.ts"
import * as RunScript from "./host/RunTables.ts"

/**
 * An option that takes `fallback` when absent. A present value must decode.
 * `undefined` counts as absent: a host passing options in-process leaves an
 * unset one undefined, and a JSON config cannot write it.
 */
const withDefault =
  <A>(fallback: A) =>
  <S extends Schema.Codec<A, any, never, never>>(schema: S) =>
    schema.pipe(Schema.withDecodingDefaultType(Effect.succeed(fallback)))

export const Options = Schema.Struct({
  log: Schema.String.pipe(withDefault(join(homedir(), ".cache/orchestrate/opencode-agents.jsonl"))),
  statusScript: Schema.String.pipe(withDefault(join(homedir(), ".claude/skills/orchestrate/scripts/status.ts"))),
})
export type Options = typeof Options.Type

/** The outside systems the model runs on. */
export type Externals = CallLog | RunTables

/** The live systems: the call log file and the status script. */
export const live = (options: Options): Layer.Layer<Externals> =>
  Layer.merge(CallLogFile.layer(options.log), RunScript.layer(options.statusScript))

/** The plugin on `externals`: the live systems in OpenCode, test layers in the seam tests. */
export const make = (externals: (options: Options) => Layer.Layer<Externals>) =>
  Plugin.define({
    id: "dotfiles-opencode.status",
    effect: Effect.fn("Status.plugin")(function* (ctx) {
      // A malformed option is a mistake in the config: the plugin does not start, and says which.
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(
        Effect.mapError((error) => new Error(`dotfiles-opencode.status: invalid options: ${error.message}`)),
        Effect.orDie,
      )
      const services = yield* Layer.build(Model.layer.pipe(Layer.provide(externals(options))))
      const status = Context.get(services, Model.Status)
      // Each call reads afresh: the answer says what could not be read rather
      // than failing. An RPC that cannot be registered stops the plugin.
      yield* ctx.rpc.register(STATUS, { status: () => status.snapshot(ctx.location.directory) }).pipe(Effect.orDie)
    }),
  })

export default make(live)
