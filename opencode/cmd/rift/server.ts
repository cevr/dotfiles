/**
 * The rift tool as an OpenCode server plugin. The composition root: it
 * builds the model (`@dotfiles/opencode-rift/model`) on Rift, Git, the
 * workbox's scripts and OpenCode's sessions, registers the `rift` tool (a
 * direct tool, reached from a kernel cell as `tools.rift`), and takes
 * OpenCode's worktree tools (`opencode_worktree_create`, `_list`, `_remove`)
 * out of the registry, so an agent sees Rift's tool alone. Those tools make
 * and remove Git worktrees, which a Rift is not: on Rifts they failed.
 *
 * `rift({ action: "create" | "list" | "remove" | "land" | <workbox action>, ... })`:
 * see `@dotfiles/opencode-rift/rift` for the input and the answers,
 * `@dotfiles/opencode-rift/workspace` for what a removal refuses, and
 * `@dotfiles/opencode-rift/land` for a land. A land's accept check runs in
 * the plugin's scope and wakes the calling session through
 * `session.synthetic`; its logs go to `${XDG_CACHE_HOME:-~/.cache}/rift-land`.
 *
 * Options (all optional; an absent one takes its default, a malformed one stops the plugin):
 * - `workrift`: make and remove Rifts with `workrift` (the workbox's branch
 *   workflow on top of Rift), and offer its own commands; default: whether
 *   `workrift` is on PATH.
 */
import { Plugin, Tool } from "@opencode/plugin/effect"
import { Context, Effect, Layer, Schema } from "effect"
import * as Model from "@dotfiles/opencode-rift/model"
import * as OpenCodeNotices from "@dotfiles/opencode-rift/opencode/notices"
import * as OpenCodeSessionDirectories from "@dotfiles/opencode-rift/opencode/session-directories"
import * as ProcessLanding from "@dotfiles/opencode-rift/process/landing"
import * as ProcessRifts from "@dotfiles/opencode-rift/process/rifts"
import * as ProcessWorkbox from "@dotfiles/opencode-rift/process/workbox"
import { RIFT_DESCRIPTION, RiftInput } from "@dotfiles/opencode-rift/rift"
import type { Landing, Notices, Rifts, SessionDirectories, Workbox } from "@dotfiles/opencode-rift/service"

/** OpenCode's worktree tools, by their registry ids; the rift tool replaces them. */
export const WORKTREE_TOOLS = ["opencode_worktree_create", "opencode_worktree_list", "opencode_worktree_remove"] as const

export const Options = Schema.Struct({
  workrift: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.sync(() => Bun.which("workrift") !== null))),
})
export type Options = typeof Options.Type

/** The outside systems the model runs on. */
export type Externals = Rifts | SessionDirectories | Landing | Notices | Workbox

type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]
type SyntheticInput = Parameters<Plugin.Context["session"]["synthetic"]>[0]

/** Where a land's gate and accept logs go. */
export const landLogs = (): string => ProcessLanding.landLogs(process.env)

/** The outside systems as Rift, Git, the workbox and OpenCode provide them. */
export const live = (ctx: Plugin.Context, options: Options): Layer.Layer<Externals> =>
  Layer.mergeAll(
    ProcessRifts.layer({ workrift: options.workrift }),
    ProcessLanding.layer({ logs: landLogs() }),
    ProcessWorkbox.layer({ workrift: options.workrift }),
    OpenCodeNotices.layer((input) => ctx.session.synthetic({ ...input, sessionID: input.sessionID as SessionID, metadata: { ...input.metadata } } as SyntheticInput)),
    OpenCodeSessionDirectories.layer((sessionID) =>
      ctx.session.get({ sessionID: sessionID as SessionID }).pipe(Effect.map((session) => session.location.directory)),
    ),
  )

/** The plugin on `externals`: the live systems in OpenCode, memory layers in the seam test. */
export const make = (externals: (ctx: Plugin.Context, options: Options) => Layer.Layer<Externals>) =>
  Plugin.define({
    id: "dotfiles-opencode.rift",
    effect: Effect.fn("Rift.plugin")(function* (ctx) {
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options ?? {}).pipe(
        Effect.mapError((error) => new Error(`dotfiles-opencode.rift: invalid options: ${error.message}`)),
        Effect.orDie,
      )
      // Built in the plugin's scope: a land's background accept check lives as long as the plugin.
      const services = yield* Layer.build(Model.layer.pipe(Layer.provide(externals(ctx, options))))
      const rift = Context.get(services, Model.RiftTool)

      yield* ctx.tool.transform((editor) => {
        for (const id of WORKTREE_TOOLS) editor.remove(id)
        editor.add({
          name: "rift",
          description: RIFT_DESCRIPTION,
          input: RiftInput,
          options: { codemode: false },
          execute: (input, context) =>
            rift.run(context.sessionID, input).pipe(
              Effect.map((answer) => ({ content: [{ type: "text" as const, text: answer.text }], metadata: answer.metadata })),
              Effect.mapError((failure) => new Tool.Error({ message: Model.explain(failure), error: failure })),
            ),
        })
      })
    }),
  })

export default make(live)
