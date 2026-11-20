/**
 * The work tool as an OpenCode server plugin: `cmd/rift/server.ts`'s composition root with Ergo's `work`
 * binary in place of Rift. It builds the same model (`@dotfiles/opencode-work/model`) on `work`
 * (`@dotfiles/opencode-work/process/work`), Git, the workbox's scripts and OpenCode's sessions, registers
 * the `work` tool and its alias `rift` (one release: removed on `RIFT_ALIAS_REMOVAL`, the same input and the
 * same answers), and takes OpenCode's worktree tools out of the registry. Everything but the Rifts provider
 * is cmd/rift's `live`, imported.
 *
 * It serves the rift RPC (`@dotfiles/opencode-work/rpc`) under `RIFT_RPC` on the same model, for the
 * orchestrate plugin's `orchestrate` tool, with cmd/rift's answers.
 *
 * It must never load beside cmd/rift: both register the `rift` tool and the rift RPC, and both run the
 * owed post-land check on one `post-land-owed.json`. OpenCode loads one or the other (`scripts/daily.ts`,
 * `opencode.json`); until the swap that is cmd/rift.
 *
 * Options (all optional; an absent one takes its default, a malformed one stops the plugin):
 * - `workrift`: make and remove workspaces with `workrift` (the workbox), and offer its own commands;
 *   default: whether `workrift` is on PATH.
 * - `work`: the `work` binary, a path or a name on PATH; default `work`. One that is not there stops the
 *   plugin, naming it.
 */
import { Plugin, Tool } from "@opencode/plugin/effect"
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as RiftServer from "@dotfiles/opencode-cmd-rift/server"
import * as Model from "@dotfiles/opencode-work/model"
import { commands } from "@dotfiles/opencode-work/process/command"
import * as ProcessWork from "@dotfiles/opencode-work/process/work"
import { RiftInput, listed, stateOf } from "@dotfiles/opencode-work/rift"
import {
  CreateAsk,
  type Created,
  type Failed,
  DescribeAsk,
  InspectAsk,
  type Inspected,
  type LandAnswered,
  LandAsk,
  type Lane,
  ListAsk,
  type Listed,
  RIFT_RPC,
} from "@dotfiles/opencode-work/rpc"
import { Rifts, SessionDirectories } from "@dotfiles/opencode-work/service"
import { RIFT_ALIAS_DESCRIPTION, WORK_DESCRIPTION } from "@dotfiles/opencode-work/tool"
import type { Workspace } from "@dotfiles/opencode-work/workspace"

/** OpenCode's worktree tools, by their registry ids; the work tool replaces them. */
export const WORKTREE_TOOLS = RiftServer.WORKTREE_TOOLS

export const Options = Schema.Struct({
  ...RiftServer.Options.fields,
  work: Schema.String.pipe(Schema.withDecodingDefaultType(Effect.succeed("work"))),
})
export type Options = typeof Options.Type

/** The outside systems the model runs on. */
export type Externals = RiftServer.Externals

/** Options that do not decode. */
export class OptionsInvalid extends Schema.TaggedError<OptionsInvalid>()("OptionsInvalid", { message: Schema.String }) {}

/** A `work` binary that does not start. */
export class WorkMissing extends Schema.TaggedError<WorkMissing>()("WorkMissing", { message: Schema.String }) {}

/** Stops with `WorkMissing` when `work` does not start; its answer is not read (`bases` only reads the registry). */
export const probe = (work: string) =>
  commands()
    .spawn([work, "--json", "bases"], "/")
    .pipe(Effect.asVoid, Effect.mapError((failure) => new WorkMissing({ message: `dotfiles-opencode.work: the work binary ${work} does not start: ${failure.message}` })))

/** The outside systems as `work`, Git, the workbox and OpenCode provide them: cmd/rift's, with `work` for the Rifts. */
export const live = (ctx: Plugin.Context, options: Options): Layer.Layer<Externals> =>
  Layer.unwrap(
    probe(options.work).pipe(
      Effect.orDie,
      Effect.as(Layer.merge(RiftServer.live(ctx, options), ProcessWork.layer({ work: options.work, workrift: options.workrift }))),
    ),
  )

/** The plugin on `externals`: the live systems in OpenCode, memory layers in the seam test. */
export const make = (externals: (ctx: Plugin.Context, options: Options) => Layer.Layer<Externals>) =>
  Plugin.define({
    id: "dotfiles-opencode.work",
    effect: Effect.fn("Work.plugin")(function* (ctx) {
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options ?? {}).pipe(
        Effect.mapError((error) => new OptionsInvalid({ message: `dotfiles-opencode.work: invalid options: ${error.message}` })),
        Effect.orDie,
      )
      // Built in the plugin's scope: a land's background accept check lives as long as the plugin.
      const services = yield* Layer.build(Model.layer.pipe(Layer.provideMerge(externals(ctx, options))))
      const tool = Context.get(services, Model.RiftTool)
      const execute = (input: RiftInput, context: { readonly sessionID: string }) =>
        tool.run(context.sessionID, input).pipe(
          Effect.map((answer) => ({ content: [{ type: "text" as const, text: answer.text }], metadata: answer.metadata })),
          Effect.mapError((failure) => new Tool.Error({ message: Model.explain(failure), error: failure })),
        )

      yield* ctx.tool.transform((editor) => {
        for (const id of WORKTREE_TOOLS) editor.remove(id)
        editor.add({ name: "work", description: WORK_DESCRIPTION, input: RiftInput, options: { codemode: false }, execute })
        editor.add({ name: "rift", description: RIFT_ALIAS_DESCRIPTION, input: RiftInput, options: { codemode: false }, execute })
      })

      // The rift RPC (`@dotfiles/opencode-work/rpc`), on the model the tool runs on: the tool's answer for the same input.
      const answers = rpcHandlers(tool, Context.get(services, Rifts), Context.get(services, SessionDirectories), options)
      yield* ctx.rpc
        .register(RIFT_RPC, {
          create: (input) => answering("create", Schema.decodeUnknownEffect(CreateAsk)(input), answers.create),
          list: (input) => answering("list", Schema.decodeUnknownEffect(ListAsk)(input), answers.list),
          inspect: (input) => answering("inspect", Schema.decodeUnknownEffect(InspectAsk)(input), answers.inspect),
          describe: (input) => answering("describe", Schema.decodeUnknownEffect(DescribeAsk)(input), answers.describe),
          land: (input) => answering("land", Schema.decodeUnknownEffect(LandAsk)(input), answers.land),
        })
        .pipe(Effect.orDie)
    }),
  })

/** A workspace as the RPC answers carry it. */
const laneOf = (workspace: Workspace): Lane => {
  const lane = {
    path: workspace.path,
    head: workspace.head,
    state: stateOf(workspace),
    ...Option.match(Option.fromUndefinedOr(workspace.purpose), { onNone: () => ({}), onSome: (purpose) => ({ purpose }) }),
  }
  return Option.match(Option.fromUndefinedOr(workspace.branch), { onNone: () => lane, onSome: (branch) => ({ ...lane, branch }) })
}

/** A failure in the tool's words. */
const failedOf = (failure: Model.Failure): Failed => ({ outcome: "failed", message: Model.explain(failure) })

/** An ask that does not decode, in words: cmd/rift's, which the orchestrate plugin reads. */
const malformed = (method: string) => (error: { readonly message: string }) => Effect.succeed<Failed>({ outcome: "failed", message: `not a rift ${method}: ${error.message}` })

/**
 * The RPC's handlers: each runs the tool's own model on the ask, and reads the workspaces it names for the
 * answer's data. cmd/rift's, which keeps its own copy until work-cleanup deletes it.
 */
const rpcHandlers = (tool: typeof Model.RiftTool.Service, rifts: typeof Rifts.Service, sessions: typeof SessionDirectories.Service, options: Options) => {
  /** The warm source the session's directory, or the ask's `source` against it, belongs to. */
  const sourceOf = (sessionID: string, source: Option.Option<string>) =>
    sessions.directoryOf(sessionID).pipe(
      Effect.flatMap((directory) => rifts.source(Option.match(source, { onNone: () => directory, onSome: (asked) => Model.resolvePath(directory, asked) }))),
    )
  const created = ({ sessionID, at, purpose, ...asked }: CreateAsk) =>
    tool.run(sessionID, { action: "create", ...asked }, Option.fromUndefinedOr(at)).pipe(
      Effect.tap((answer) => Effect.forEach(Option.toArray(Option.fromUndefinedOr(purpose)), (text) => rifts.describe(answer.metadata.path ?? "", text), { discard: true })),
      Effect.flatMap((answer) => rifts.inspect(answer.metadata.path ?? "").pipe(Effect.map((workspace): Created => ({ outcome: "answered", text: answer.text, rift: laneOf(workspace) })))),
      Effect.catch((failure) => Effect.succeed<Created>(failedOf(failure))),
    )
  const described = (ask: DescribeAsk) =>
    Effect.gen(function* () {
      const directory = yield* sessions.directoryOf(ask.sessionID)
      const path = Model.resolvePath(directory, ask.path)
      yield* rifts.describe(path, ask.purpose)
      const workspace = yield* rifts.inspect(path)
      return { outcome: "answered", text: listed(directory, [workspace]).split("\n").at(-1) ?? "", rift: laneOf(workspace) } satisfies Inspected
    }).pipe(Effect.catch((failure) => Effect.succeed<Inspected>(failedOf(failure))))
  const listedOf = ({ sessionID, ...asked }: ListAsk) =>
    Effect.gen(function* () {
      const answer = yield* tool.run(sessionID, { action: "list", ...asked })
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
    tool.run(sessionID, { action: "land", ...asked }).pipe(
      Effect.map((answer): LandAnswered => ({ outcome: "answered", text: answer.text })),
      Effect.catch((failure) => Effect.succeed<LandAnswered>(failedOf(failure))),
    )
  return { create: created, list: listedOf, inspect: inspected, describe: described, land: landed }
}

/** An ask decoded, then answered; one that does not decode is refused in words. */
const answering = <A, B>(method: string, decoded: Effect.Effect<A, { readonly message: string }>, act: (ask: A) => Effect.Effect<B>) =>
  decoded.pipe(Effect.flatMap(act), Effect.catch(malformed(method)))

export default make(live)
