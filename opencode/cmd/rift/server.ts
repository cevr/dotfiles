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
 * `session.synthetic`; its logs go to `${XDG_CACHE_HOME:-~/.cache}/rift-land`, and
 * a post-land step owed while the host is loaded (`@dotfiles/opencode-rift/owed`)
 * to `post-land-owed.json` there, which the plugin's check reads every minute.
 *
 * It also serves the rift RPC (`@dotfiles/opencode-rift/rpc`: create, with `at` to detach a new Rift at a commit,
 * list, inspect, land) on the same model, for the orchestrate plugin's `orchestrate` tool.
 *
 * Options (all optional; an absent one takes its default, a malformed one stops the plugin):
 * - `workrift`: make and remove Rifts with `workrift` (the workbox's branch
 *   workflow on top of Rift), and offer its own commands; default: whether
 *   `workrift` is on PATH.
 */
import { Plugin, Tool } from "@opencode/plugin/effect"
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as FilestoreDebts from "@dotfiles/opencode-rift/filestore/debts"
import * as Model from "@dotfiles/opencode-rift/model"
import * as OpenCodeNotices from "@dotfiles/opencode-rift/opencode/notices"
import * as OpenCodeSessionDirectories from "@dotfiles/opencode-rift/opencode/session-directories"
import * as ProcessLanding from "@dotfiles/opencode-rift/process/landing"
import * as ProcessRifts from "@dotfiles/opencode-rift/process/rifts"
import * as ProcessWorkbox from "@dotfiles/opencode-rift/process/workbox"
import { RIFT_DESCRIPTION, RiftInput, listed, stateOf } from "@dotfiles/opencode-rift/rift"
import {
  CreateAsk,
  type Created,
  type Failed,
  InspectAsk,
  type Inspected,
  type LandAnswered,
  LandAsk,
  type Lane,
  ListAsk,
  type Listed,
  RIFT_RPC,
} from "@dotfiles/opencode-rift/rpc"
import { type Landing, type Notices, type PostLandClaim, type PostLandDebts, Rifts, SessionDirectories, type Workbox } from "@dotfiles/opencode-rift/service"
import type { Workspace } from "@dotfiles/opencode-rift/workspace"

/** OpenCode's worktree tools, by their registry ids; the rift tool replaces them. */
export const WORKTREE_TOOLS = ["opencode_worktree_create", "opencode_worktree_list", "opencode_worktree_remove"] as const

export const Options = Schema.Struct({
  workrift: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.sync(() => Bun.which("workrift") !== null))),
})
export type Options = typeof Options.Type

/** The outside systems the model runs on. */
export type Externals = Rifts | SessionDirectories | Landing | Notices | Workbox | PostLandDebts | PostLandClaim

type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]
type SyntheticInput = Parameters<Plugin.Context["session"]["synthetic"]>[0]

/** Where a land's gate and accept logs go. */
export const landLogs = (): string => ProcessLanding.landLogs(process.env)

/** The outside systems as Rift, Git, the workbox and OpenCode provide them. */
export const live = (ctx: Plugin.Context, options: Options): Layer.Layer<Externals> =>
  Layer.mergeAll(
    ProcessRifts.layer({ workrift: options.workrift }),
    ProcessLanding.layer({ logs: landLogs() }),
    FilestoreDebts.layer(FilestoreDebts.debtsFile(landLogs())),
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
      const services = yield* Layer.build(Model.layer.pipe(Layer.provideMerge(externals(ctx, options))))
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

      // The rift RPC (`@dotfiles/opencode-rift/rpc`), on the model the tool runs on: the tool's answer for the same input.
      const answers = rpcHandlers(rift, Context.get(services, Rifts), Context.get(services, SessionDirectories), options)
      yield* ctx.rpc
        .register(RIFT_RPC, {
          create: (input) => answering("create", Schema.decodeUnknownEffect(CreateAsk)(input), answers.create),
          list: (input) => answering("list", Schema.decodeUnknownEffect(ListAsk)(input), answers.list),
          inspect: (input) => answering("inspect", Schema.decodeUnknownEffect(InspectAsk)(input), answers.inspect),
          land: (input) => answering("land", Schema.decodeUnknownEffect(LandAsk)(input), answers.land),
        })
        .pipe(Effect.orDie)
    }),
  })

/** A Rift as the RPC answers carry it. */
const laneOf = (workspace: Workspace): Lane => {
  const lane = { path: workspace.path, head: workspace.head, state: stateOf(workspace) }
  return Option.match(Option.fromUndefinedOr(workspace.branch), { onNone: () => lane, onSome: (branch) => ({ ...lane, branch }) })
}

/** A failure in the tool's words. */
const failedOf = (failure: Model.Failure): Failed => ({ outcome: "failed", message: Model.explain(failure) })

/** An ask that does not decode, in words. */
const malformed = (method: string) => (error: { readonly message: string }) => Effect.succeed<Failed>({ outcome: "failed", message: `not a rift ${method}: ${error.message}` })

/** The RPC's handlers: each runs the tool's own model on the ask, and reads the Rifts it names for the answer's data. */
const rpcHandlers = (rift: typeof Model.RiftTool.Service, rifts: typeof Rifts.Service, sessions: typeof SessionDirectories.Service, options: Options) => {
  /** The warm source the session's directory, or the ask's `source` against it, belongs to. */
  const sourceOf = (sessionID: string, source: Option.Option<string>) =>
    sessions.directoryOf(sessionID).pipe(
      Effect.flatMap((directory) => rifts.source(Option.match(source, { onNone: () => directory, onSome: (asked) => Model.resolvePath(directory, asked) }))),
    )
  const created = ({ sessionID, at, ...asked }: CreateAsk) =>
    rift.run(sessionID, { action: "create", ...asked }, Option.fromUndefinedOr(at)).pipe(
      Effect.flatMap((answer) => rifts.inspect(answer.metadata.path ?? "").pipe(Effect.map((workspace): Created => ({ outcome: "answered", text: answer.text, rift: laneOf(workspace) })))),
      Effect.catch((failure) => Effect.succeed<Created>(failedOf(failure))),
    )
  const listedOf = ({ sessionID, ...asked }: ListAsk) =>
    Effect.gen(function* () {
      const answer = yield* rift.run(sessionID, { action: "list", ...asked })
      const source = yield* sourceOf(sessionID, Option.fromUndefinedOr(asked.source))
      const workspaces = yield* Effect.forEach(yield* rifts.list(source), rifts.inspect, { concurrency: 4 })
      return { outcome: "answered", text: answer.text, source, workrift: options.workrift, rifts: workspaces.map(laneOf) } satisfies Listed
    }).pipe(Effect.catch((failure) => Effect.succeed<Listed>(failedOf(failure))))
  const inspected = (ask: InspectAsk) =>
    Effect.gen(function* () {
      const directory = yield* sessions.directoryOf(ask.sessionID)
      const workspace = yield* rifts.inspect(Model.resolvePath(directory, ask.path))
      // Its line in the tool's list answer.
      const line = listed(directory, [workspace]).split("\n").at(-1) ?? ""
      return { outcome: "answered", text: line, rift: laneOf(workspace) } satisfies Inspected
    }).pipe(Effect.catch((failure) => Effect.succeed<Inspected>(failedOf(failure))))
  const landed = ({ sessionID, ...asked }: LandAsk) =>
    rift.run(sessionID, { action: "land", ...asked }).pipe(
      Effect.map((answer): LandAnswered => ({ outcome: "answered", text: answer.text })),
      Effect.catch((failure) => Effect.succeed<LandAnswered>(failedOf(failure))),
    )
  return { create: created, list: listedOf, inspect: inspected, land: landed }
}

/** An ask decoded, then answered; one that does not decode is refused in words. */
const answering = <A, B>(method: string, decoded: Effect.Effect<A, { readonly message: string }>, act: (ask: A) => Effect.Effect<B>) =>
  decoded.pipe(Effect.flatMap(act), Effect.catch(malformed(method)))

export default make(live)
