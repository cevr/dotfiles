/**
 * The rift tool as an OpenCode server plugin. The composition root: it
 * builds the model (`@dotfiles/opencode-rift/model`) on Rift, Git and
 * OpenCode's sessions, registers the `rift` tool (a direct tool, reached from
 * a kernel cell as `tools.rift`), and takes OpenCode's worktree tools
 * (`opencode_worktree_create`, `_list`, `_remove`) out of the registry, so an
 * agent sees Rift's tool alone. Those tools make and remove Git worktrees,
 * which a Rift is not: on Rifts they failed.
 *
 * `rift({ action: "create" | "list" | "remove", ... })`: see
 * `@dotfiles/opencode-rift/rift` for the input and the answers, and
 * `@dotfiles/opencode-rift/workspace` for what a removal refuses.
 *
 * Options (all optional; an absent one takes its default, a malformed one stops the plugin):
 * - `workrift`: make and remove Rifts with `workrift` (the workbox's branch
 *   workflow on top of Rift); default: whether `workrift` is on PATH.
 */
import { Plugin, Tool } from "@opencode/plugin/effect"
import { Context, Effect, Layer, Schema } from "effect"
import * as Model from "@dotfiles/opencode-rift/model"
import * as OpenCodeSessionDirectories from "@dotfiles/opencode-rift/opencode/session-directories"
import * as ProcessRifts from "@dotfiles/opencode-rift/process/rifts"
import { RIFT_DESCRIPTION, RiftInput, explainInput } from "@dotfiles/opencode-rift/rift"
import type { Rifts, SessionDirectories } from "@dotfiles/opencode-rift/service"
import { explainRefusal } from "@dotfiles/opencode-rift/workspace"

/** OpenCode's worktree tools, by their registry ids; the rift tool replaces them. */
export const WORKTREE_TOOLS = ["opencode_worktree_create", "opencode_worktree_list", "opencode_worktree_remove"] as const

export const Options = Schema.Struct({
  workrift: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.sync(() => Bun.which("workrift") !== null))),
})
export type Options = typeof Options.Type

/** The outside systems the model runs on. */
export type Externals = Rifts | SessionDirectories

type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]

/** The outside systems as Rift, Git and OpenCode provide them. */
export const live = (ctx: Plugin.Context, options: Options): Layer.Layer<Externals> =>
  Layer.mergeAll(
    ProcessRifts.layer({ workrift: options.workrift }),
    OpenCodeSessionDirectories.layer((sessionID) =>
      ctx.session.get({ sessionID: sessionID as SessionID }).pipe(Effect.map((session) => session.location.directory)),
    ),
  )

/** What the model reads when a call does not act. */
const messageOf = (failure: Model.Failure): string => {
  switch (failure._tag) {
    case "BranchMissing":
    case "TargetMissing":
    case "NoSuchRift":
      return explainInput(failure)
    case "SourceKept":
    case "SessionInside":
    case "ChildrenKept":
    case "WorkUnsaved":
      return explainRefusal(failure)
    case "RiftFailed":
    case "SessionUnreadable":
      return Model.failureText(failure)
  }
}

/** The plugin on `externals`: the live systems in OpenCode, memory layers in the seam test. */
export const make = (externals: (ctx: Plugin.Context, options: Options) => Layer.Layer<Externals>) =>
  Plugin.define({
    id: "dotfiles-opencode.rift",
    effect: Effect.fn("Rift.plugin")(function* (ctx) {
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options ?? {}).pipe(
        Effect.mapError((error) => new Error(`dotfiles-opencode.rift: invalid options: ${error.message}`)),
        Effect.orDie,
      )
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
              Effect.mapError((failure) => new Tool.Error({ message: messageOf(failure), error: failure })),
            ),
        })
      })
    }),
  })

export default make(live)
