/**
 * The status mod's server half: an OpenCode server plugin answering the
 * status RPC (`@dotfiles/opencode-status/status`) the /pool pane reads. The
 * composition root: it decodes the options, builds the status model
 * (`@dotfiles/opencode-status/model`) on the call log (its `filestore/`
 * implementation) and the runs (its `process/` implementation), and registers
 * the RPC.
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
import * as CallLogFile from "@dotfiles/opencode-status/filestore/call-log"
import * as Model from "@dotfiles/opencode-status/model"
import * as RunScript from "@dotfiles/opencode-status/process/run-tables"
import type { CallLog, RunTables } from "@dotfiles/opencode-status/service"
import { STATUS } from "@dotfiles/opencode-status/status"

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
