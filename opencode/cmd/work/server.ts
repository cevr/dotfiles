/**
 * The work tool as an OpenCode server plugin, the composition root of `@dotfiles/opencode-work`. It builds
 * the model (`@dotfiles/opencode-work/model`) on Ergo's `work` binary (`@dotfiles/opencode-work/process/work`),
 * Git, the workbox's scripts and OpenCode's sessions, registers the `work` tool and its alias `rift` (one
 * release: removed on `RIFT_ALIAS_REMOVAL`, the same input and the same answers), and takes OpenCode's
 * worktree tools (`opencode_worktree_create`, `_list`, `_remove`) out of the registry: they make and remove
 * Git worktrees, which a workspace is not. A land's accept check runs in the plugin's scope and wakes the
 * calling session through `session.synthetic`; its logs go to `${XDG_CACHE_HOME:-~/.cache}/rift-land`, and an
 * owed accept check or post-land step (`@dotfiles/opencode-work/owed`) to `post-land-owed.json` there, which
 * the plugin's check reads every minute, so one a restart cut off runs again.
 *
 * It serves the rift RPC (`@dotfiles/opencode-work/rpc`: create, with `at` to detach a new workspace at a
 * commit, list, inspect, land) under `RIFT_RPC` on the same model, for the orchestrate plugin's `orchestrate` tool.
 *
 * Options (all optional; an absent one takes its default, a malformed one stops the plugin):
 * - `workrift`: make and remove workspaces with `workrift` (the workbox), and offer its own commands;
 *   default: whether `workrift` is on PATH.
 * - `work`: the `work` binary, a path or a name on PATH; default `work`. One that is not there stops the
 *   plugin, naming it.
 */
import { Plugin, Tool } from "@opencode/plugin/effect"
import { Config, Context, Effect, Layer, Option, Predicate, Schema } from "effect"
import * as FilestoreDebts from "@dotfiles/opencode-work/filestore/debts"
import * as Model from "@dotfiles/opencode-work/model"
import * as OpenCodeNotices from "@dotfiles/opencode-work/opencode/notices"
import * as OpenCodeSessionDirectories from "@dotfiles/opencode-work/opencode/session-directories"
import { commands } from "@dotfiles/opencode-work/process/command"
import * as ProcessLanding from "@dotfiles/opencode-work/process/landing"
import * as ProcessWork from "@dotfiles/opencode-work/process/work"
import * as ProcessWorkbox from "@dotfiles/opencode-work/process/workbox"
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
import { type Landing, type Notices, type PostLandClaim, type PostLandDebts, Rifts, SessionDirectories, type Workbox } from "@dotfiles/opencode-work/service"
import { RIFT_ALIAS_DESCRIPTION, WORK_DESCRIPTION } from "@dotfiles/opencode-work/tool"
import type { Workspace } from "@dotfiles/opencode-work/workspace"

/** OpenCode's worktree tools, by their registry ids; the work tool replaces them. */
export const WORKTREE_TOOLS = ["opencode_worktree_create", "opencode_worktree_list", "opencode_worktree_remove"] as const

export const Options = Schema.Struct({
  workrift: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.sync(() => Predicate.isNotNull(Bun.which("workrift"))))),
  work: Schema.String.pipe(Schema.withDecodingDefaultType(Effect.succeed("work"))),
})
export type Options = typeof Options.Type

/** The outside systems the model runs on. */
export type Externals = Rifts | SessionDirectories | Landing | Notices | Workbox | PostLandDebts | PostLandClaim

/**
 * A session id as OpenCode's session calls take it; one that is no session id fails, as the call would. The server
 * host serves no `@opencode/schema`, so this is its `session-id` schema built here: the same check and brand.
 */
const sessionIdOf = Schema.decodeUnknownEffect(Schema.String.check(Schema.isStartingWith("ses")).pipe(Schema.brand("SessionID")))

/**
 * The outside systems but the workspaces: Git and the land's checks, the owed post-land steps (their logs in
 * `${XDG_CACHE_HOME:-~/.cache}/rift-land`), the workbox and OpenCode's sessions. A seam test puts memory doubles
 * over the process ones.
 */
export const hostSystems = (ctx: Plugin.Context, options: Pick<Options, "workrift">): Layer.Layer<Exclude<Externals, Rifts>> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const cache = yield* Config.option(Config.String("XDG_CACHE_HOME"))
      const logs = ProcessLanding.landLogs(Option.match(cache, { onNone: () => ({}), onSome: (XDG_CACHE_HOME) => ({ XDG_CACHE_HOME }) }))
      return Layer.mergeAll(
        ProcessLanding.layer({ logs }),
        FilestoreDebts.layer(FilestoreDebts.debtsFile(logs)),
        ProcessWorkbox.layer({ workrift: options.workrift }),
        OpenCodeNotices.layer((input) =>
          sessionIdOf(input.sessionID).pipe(Effect.flatMap((sessionID) => ctx.session.synthetic({ ...input, sessionID, metadata: { ...input.metadata } }))),
        ),
        OpenCodeSessionDirectories.layer((sessionID) =>
          sessionIdOf(sessionID).pipe(
            Effect.flatMap((id) => ctx.session.get({ sessionID: id })),
            Effect.map((session) => session.location.directory),
          ),
        ),
      )
    }).pipe(Effect.orDie),
  )

/** Options that do not decode. */
export class OptionsInvalid extends Schema.TaggedError<OptionsInvalid>()("OptionsInvalid", { message: Schema.String }) {}

/** A `work` binary that does not start. */
export class WorkMissing extends Schema.TaggedError<WorkMissing>()("WorkMissing", { message: Schema.String }) {}

/** Stops with `WorkMissing` when `work` does not start; its answer is not read (`bases` only reads the registry). */
export const probe = (work: string) =>
  commands()
    .spawn([work, "--json", "bases"], "/")
    .pipe(Effect.asVoid, Effect.mapError((failure) => new WorkMissing({ message: `dotfiles-opencode.work: the work binary ${work} does not start: ${failure.message}` })))

/** The outside systems as `work`, Git, the workbox and OpenCode provide them. */
export const live = (ctx: Plugin.Context, options: Options): Layer.Layer<Externals> =>
  Layer.unwrap(
    probe(options.work).pipe(
      Effect.orDie,
      Effect.as(Layer.merge(hostSystems(ctx, options), ProcessWork.layer({ work: options.work, workrift: options.workrift }))),
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

/** An ask that does not decode, in words, which the orchestrate plugin reads. */
const malformed = (method: string) => (error: { readonly message: string }) => Effect.succeed<Failed>({ outcome: "failed", message: `not a work ${method}: ${error.message}` })

/** The RPC's handlers: each runs the tool's own model on the ask, and reads the workspaces it names for the answer's data. */
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
