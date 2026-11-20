import { file, spawn } from "bun"
import { Effect, Layer, Option, Result, Schema } from "effect"
import { readText } from "../filestore/files.ts"
import { buildOf, parseRecord, promoted } from "../record.ts"
import { Handoff, UpdateFailed } from "../service.ts"
import { files, HANDOFF_SETTINGS, type Settings, SettingsJson } from "../settings.ts"
import { treeOf } from "../trees.ts"
import { environment } from "./run.ts"

const encodeSettings = Schema.encodeSync(SettingsJson)

/** Where the handoff's program runs from: its file, and the directory it runs in. */
export interface Program {
  readonly path: string
  readonly cwd: string
}

/** The handoff's program in the plugin tree `tree` of a build (`trees.ts`). */
export const treeProgram = (tree: string): Program => ({ path: `${tree}/opencode/cmd/update/handoff.ts`, cwd: `${tree}/opencode` })

/**
 * The handoff the record's next build runs (the staged build, else the installed one): its own, from
 * the tree beside its executable, so the restart, the health check and the recovery are the target's
 * code. A build with no handoff in a tree (no record, or a tree deleted by hand) fails the start,
 * naming the build: nothing else runs a handoff. `exists` is the file system's, but for a test.
 */
export const programOf = (recordText: Option.Option<string>, exists: (path: string) => boolean): Result.Result<Program, UpdateFailed> => {
  const build = Option.flatMap(Option.flatMap(recordText, parseRecord), (record) => buildOf(promoted(record)))
  return Option.match(
    Option.filter(
      Option.map(build, (each) => treeProgram(treeOf(each.command[0]))),
      (program) => exists(program.path),
    ),
    {
      onSome: Result.succeed,
      onNone: () =>
        Result.fail(
          new UpdateFailed({
            step: "start the handoff",
            message: `${Option.match(build, { onNone: () => "the record names no build", onSome: (each) => `the build ${each.version} has no handoff in a plugin tree beside it` })}; nothing restarts`,
          }),
        ),
    },
  )
}

/** `programOf` over the files: the record as it reads now, and whether the tree's handoff is there. */
const programNow = (settings: Settings) =>
  Effect.gen(function* () {
    const text = yield* readText(settings.record)
    const tree = Option.map(Option.flatMap(Option.flatMap(text, parseRecord), (record) => buildOf(promoted(record))), (build) => treeProgram(treeOf(build.command[0])).path)
    const there = yield* Effect.forEach(Option.toArray(tree), (path) => Effect.tryPromise(() => file(path).exists()).pipe(Effect.orElseSucceed(() => false)))
    return yield* Effect.fromResult(programOf(text, () => there.includes(true)))
  })

/** The handoff's command: its program, the reason to log. */
export const handoffCommand = (settings: Settings, program: Program, reason: string): ReadonlyArray<string> => [settings.bun, program.path, reason]

/**
 * The Handoff as a detached process: a session of its own (`detached`), so neither the service's
 * exit nor its process group's takes it down, its output in the handoff log, and nothing of it
 * held by the service.
 */
export const layer = (settings: Settings, env: Readonly<globalThis.Record<string, string>>) =>
  Layer.succeed(Handoff, Handoff.of({ start: (reason) => programNow(settings).pipe(Effect.flatMap((program) => spawnHandoff(settings, env, program, reason))) }))

/** Starts the handoff's `program`, detached, its output in the handoff log. */
const spawnHandoff = (settings: Settings, env: Readonly<globalThis.Record<string, string>>, program: Program, reason: string) =>
  Effect.try({
    try: () => {
      const log = file(files(settings).handoff)
      const child = spawn([...handoffCommand(settings, program, reason)], {
        cwd: program.cwd,
        env: environment({ ...env, [HANDOFF_SETTINGS]: encodeSettings(settings) }),
        stdin: "ignore",
        stdout: log,
        stderr: log,
        detached: true,
      })
      child.unref()
    },
    catch: (cause) => new UpdateFailed({ step: "start the handoff", message: String(cause) }),
  })
