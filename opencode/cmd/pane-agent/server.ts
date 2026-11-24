import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import * as FsResults from "@dotfiles/opencode-pane-agent/filesystem/results"
import * as FileStore from "@dotfiles/opencode-pane-agent/filestore/store"
import * as Model from "@dotfiles/opencode-pane-agent/model"
import * as OpenCodeNotifier from "@dotfiles/opencode-pane-agent/opencode/notifier"
import * as RexSdkClient from "@dotfiles/opencode-pane-agent/rex/client"
import type { Notifier, ResultFiles, RexClient, WorkerStore } from "@dotfiles/opencode-pane-agent/service"
import { DESCRIPTION, PANE_AGENT_TOOL, PaneAgentInput } from "@dotfiles/opencode-pane-agent/tool"
import { BindPaneRequest, PANE_AGENT, type PaneWorker, RowsRequest } from "@dotfiles/opencode-pane-agent/worker"
import { Plugin, Tool } from "@opencode/plugin/effect"
import { Clock, Context, Effect, type FileSystem, Layer, Match, Option, Path, Ref, Schema } from "effect"

export const Options = Schema.Struct({
  stateFile: Schema.optionalKey(Schema.String),
})
export type Options = typeof Options.Type

export type Externals = RexClient | WorkerStore | ResultFiles | Notifier

const defaultStateFile = (path: Effect.Success<typeof Path.Path>): string =>
  path.join(TuiDirs.dirs().state, "opencode-pane-agent", "state.json")

const textResult = (value: string) => ({ content: [{ type: "text" as const, text: value }] })

const formatWorker = (worker: PaneWorker): string => {
  const lines = [
    `id: ${worker.id}`,
    `harness: ${worker.harness}`,
    `role: ${worker.role}`,
    `unit: ${worker.unit}`,
    `state: ${worker.state}`,
    `update: ${worker.update}`,
    `rexSession: ${worker.rexSessionId}`,
    `blockId: ${worker.blockId}`,
    `cwd: ${Option.getOrElse(Option.fromUndefinedOr(worker.cwd), () => worker.directory)}`,
    `resultFile: ${worker.resultFile}`,
    `turn: ${worker.turn}`,
  ]
  const tail = Option.filter(Option.fromUndefinedOr(worker.lastLines), (text) => text.length > 0)
  if (Option.isSome(tail)) {
    lines.push("", "lastLines:", tail.value)
  }
  return lines.join("\n")
}

const formatList = (workers: ReadonlyArray<PaneWorker>): string => {
  if (workers.length === 0) return "No pane workers in this session."
  return workers
    .map((worker) => `${worker.id}  ${worker.harness}  ${worker.state}  ${worker.role} ${worker.unit}  block=${worker.blockId}  ${worker.update}`)
    .join("\n")
}

const formatModelError = (error: Model.ModelError): Tool.Error =>
  Match.value(error).pipe(
    Match.tag("RexUnsupportedRevision", (err) => new Tool.Error({ message: err.message, error: err })),
    Match.tag("RexUnavailable", (err) => new Tool.Error({ message: `Rex is unavailable: ${err.message}`, error: err })),
    Match.tag("RexPaneGone", (err) => new Tool.Error({ message: `Rex pane is gone (${err.operation}): ${err.message}`, error: err })),
    Match.tag("RexCallFailed", (err) => new Tool.Error({ message: `Rex ${err.operation} failed: ${err.message}`, error: err })),
    Match.tag("WorkerRejected", (err) => new Tool.Error({ message: err.reason, error: err })),
    Match.tag("StoreFailed", (err) => new Tool.Error({ message: `Pane worker store ${err.operation} failed: ${err.message}`, error: err })),
    Match.tag("ResultReadFailed", (err) => new Tool.Error({ message: `Failed to read result file ${err.path}: ${err.message}`, error: err })),
    Match.exhaustive,
  )

const startFields = (
  input: PaneAgentInput,
  sessionID: string,
  directory: string,
  fallbackResultFile: string,
): Effect.Effect<Model.StartInput, Tool.Error> => {
  const harness = Option.fromUndefinedOr(input.harness)
  const description = Option.fromUndefinedOr(input.description)
  const prompt = Option.fromUndefinedOr(input.prompt)
  if (Option.isNone(harness)) {
    return Effect.fail(new Tool.Error({ message: 'pane_agent({ action: "start" }) requires harness (e.g. "agy").' }))
  }
  if (Option.isNone(description)) {
    return Effect.fail(new Tool.Error({ message: 'pane_agent({ action: "start" }) requires description.' }))
  }
  if (Option.isNone(prompt)) {
    return Effect.fail(new Tool.Error({ message: 'pane_agent({ action: "start" }) requires prompt.' }))
  }
  const resultFile = Option.getOrElse(Option.fromUndefinedOr(input.resultFile), () => fallbackResultFile)
  const base: Model.StartInput = {
    parentSessionID: sessionID,
    directory,
    harness: harness.value,
    description: description.value,
    prompt: prompt.value,
    resultFile,
  }
  const withCwd = Option.match(Option.fromUndefinedOr(input.cwd), {
    onNone: () => base,
    onSome: (cwd) => ({ ...base, cwd }),
  })
  const withAddDirs = Option.match(Option.fromUndefinedOr(input.addDirs), {
    onNone: () => withCwd,
    onSome: (addDirs) => ({ ...withCwd, addDirs }),
  })
  const withSession = Option.match(Option.fromUndefinedOr(input.rexSession), {
    onNone: () => withAddDirs,
    onSome: (rexSession) => ({ ...withAddDirs, rexSession }),
  })
  const withBlock = Option.match(Option.fromUndefinedOr(input.rexBlock), {
    onNone: () => withSession,
    onSome: (rexBlock) => ({ ...withSession, rexBlock }),
  })
  const withTarget = Option.match(Option.fromUndefinedOr(input.blockId), {
    onNone: () => withBlock,
    onSome: (blockId) => ({ ...withBlock, blockId }),
  })
  return Effect.succeed(
    Option.match(Option.fromUndefinedOr(input.skipPermissions), {
      onNone: () => withTarget,
      onSome: (skipPermissions) => ({ ...withTarget, skipPermissions }),
    }),
  )
}

const restartFields = (
  input: PaneAgentInput,
  sessionID: string,
  id: string,
): Model.RestartInput => {
  const base: Model.RestartInput = { parentSessionID: sessionID, id }
  const withPrompt = Option.match(Option.fromUndefinedOr(input.prompt), {
    onNone: () => base,
    onSome: (prompt) => ({ ...base, prompt }),
  })
  const withFile = Option.match(Option.fromUndefinedOr(input.resultFile), {
    onNone: () => withPrompt,
    onSome: (resultFile) => ({ ...withPrompt, resultFile }),
  })
  const withSession = Option.match(Option.fromUndefinedOr(input.rexSession), {
    onNone: () => withFile,
    onSome: (rexSession) => ({ ...withFile, rexSession }),
  })
  return Option.match(Option.fromUndefinedOr(input.rexBlock), {
    onNone: () => withSession,
    onSome: (rexBlock) => ({ ...withSession, rexBlock }),
  })
}

const followUpAction = Effect.fn("PaneAgent.followUpAction")(function* (
  model: Effect.Success<typeof Model.PaneAgentModel>,
  input: PaneAgentInput,
  sessionID: string,
  id: string,
  forceSteer: boolean,
) {
  const prompt = Option.fromUndefinedOr(input.prompt)
  if (Option.isNone(prompt)) {
    return yield* Effect.fail(new Tool.Error({ message: `pane_agent({ action: "${input.action}" }) requires prompt.` }))
  }
  const steer = forceSteer || input.steer === true
  const base: Model.FollowUpInput = { parentSessionID: sessionID, id, prompt: prompt.value, steer }
  const followInput: Model.FollowUpInput = Option.match(Option.fromUndefinedOr(input.resultFile), {
    onNone: () => base,
    onSome: (resultFile) => ({ ...base, resultFile }),
  })
  const worker = yield* model.followUp(followInput).pipe(Effect.mapError(formatModelError))
  return textResult(formatWorker(worker))
})

const runToolAction = Effect.fn("PaneAgent.runToolAction")(function* (
  model: Effect.Success<typeof Model.PaneAgentModel>,
  input: PaneAgentInput,
  sessionID: string,
  directory: string,
  resultsDir: string,
) {
  if (input.action === "list") {
    const workers = yield* model.list(sessionID).pipe(Effect.mapError(formatModelError))
    return textResult(formatList(workers))
  }
  if (input.action === "start") {
    const now = yield* Clock.currentTimeMillis
    const fallbackFile = `${resultsDir}/${sessionID}-${now}.md`
    const payload = yield* startFields(input, sessionID, directory, fallbackFile)
    const worker = yield* model.start(payload).pipe(Effect.mapError(formatModelError))
    return textResult(formatWorker(worker))
  }
  const id = Option.fromUndefinedOr(input.id)
  if (Option.isNone(id)) {
    return yield* Effect.fail(new Tool.Error({ message: `pane_agent({ action: "${input.action}" }) requires id.` }))
  }
  if (input.action === "status") {
    const worker = yield* model.status(sessionID, id.value).pipe(Effect.mapError(formatModelError))
    return textResult(formatWorker(worker))
  }
  if (input.action === "restart") {
    const worker = yield* model.restart(restartFields(input, sessionID, id.value)).pipe(Effect.mapError(formatModelError))
    return textResult(formatWorker(worker))
  }
  if (input.action === "stop") {
    const stopInput: Model.StopInput = {
      parentSessionID: sessionID,
      id: id.value,
      ...Option.match(Option.filter(Option.fromUndefinedOr(input.close), (flag) => flag), {
        onNone: () => ({}),
        onSome: () => ({ close: true }),
      }),
    }
    const worker = yield* model.stop(stopInput).pipe(Effect.mapError(formatModelError))
    return textResult(formatWorker(worker))
  }
  return yield* followUpAction(model, input, sessionID, id.value, input.action === "steer")
})

export const live = (
  ctx: Plugin.Context,
  options: Options,
  emitChanged: (sessionID: string) => Effect.Effect<void>,
): Layer.Layer<Externals, never, FileSystem.FileSystem | Path.Path> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const path = yield* Path.Path
      const stateFile = Option.getOrElse(Option.fromUndefinedOr(options.stateFile), () => defaultStateFile(path))
      return Layer.mergeAll(
        RexSdkClient.layer(),
        FileStore.layer(stateFile),
        FsResults.layer,
        OpenCodeNotifier.fromContext(ctx, emitChanged),
      )
    }),
  )

export const make = <R = never>(
  externals: (
    ctx: Plugin.Context,
    options: Options,
    emitChanged: (sessionID: string) => Effect.Effect<void>,
  ) => Layer.Layer<Externals, never, R>,
  config: Model.ModelConfig = {},
) =>
  Plugin.define({
    id: PANE_AGENT.id,
    effect: Effect.fn("PaneAgent.plugin")(function* (ctx) {
      const rawOptions = Option.getOrElse(Option.fromUndefinedOr(ctx.options), () => ({}))
      const options = yield* Schema.decodeUnknownEffect(Options)(rawOptions).pipe(
        Effect.orDie,
      )
      const announce = yield* Ref.make<(sessionID: string) => Effect.Effect<void>>(() => Effect.void)
      const emitChanged = (sessionID: string) =>
        Effect.flatMap(Ref.get(announce), (emit) => emit(sessionID))

      const services = yield* Layer.build(
        Model.layer(config).pipe(Layer.provide(externals(ctx, options, emitChanged))),
      )
      const model = Context.get(services, Model.PaneAgentModel)
      const resultsDir = `${TuiDirs.dirs().state}/opencode-pane-agent/results`

      yield* ctx.tool.transform((editor) => {
        editor.add({
          name: PANE_AGENT_TOOL,
          description: DESCRIPTION,
          input: PaneAgentInput,
          options: { codemode: false },
          execute: (input, context) =>
            runToolAction(model, input, context.sessionID, ctx.location.directory, resultsDir),
        })
      })

      const registration = yield* ctx.rpc
        .register(PANE_AGENT, {
          rows: (raw) =>
            Schema.decodeUnknownEffect(RowsRequest)(raw).pipe(
              Effect.flatMap(({ sessionID }) => model.views(sessionID)),
              Effect.map((workers) => ({ workers })),
              Effect.orElseSucceed(() => ({ workers: [] })),
            ),
          bindPane: (raw) =>
            Schema.decodeUnknownEffect(BindPaneRequest)(raw).pipe(
              Effect.flatMap(({ sessionID, rexSession, rexBlock }) =>
                model.bindPane(sessionID, { session: rexSession, block: rexBlock }),
              ),
              Effect.as({ ok: true }),
              Effect.orElseSucceed(() => ({ ok: false })),
            ),
        })
        .pipe(Effect.orDie)

      yield* Ref.set(announce, (sessionID) =>
        registration.events.emit("changed", { sessionID }).pipe(Effect.ignore),
      )

      // Re-attach live workers after restart without blocking plugin load if Rex is stopped or upgraded.
      yield* Effect.forkScoped(model.reattach(ctx.location.directory).pipe(Effect.ignoreCause))
    }),
  })

export default make(live)
