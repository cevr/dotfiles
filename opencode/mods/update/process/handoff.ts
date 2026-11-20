import { file, spawn } from "bun"
import { Effect, Layer, Option, Schema } from "effect"
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

/** The handoff's program in the live checkout: the old scheme's, and a build's that has no tree. */
export const checkoutProgram = (settings: Settings): Program => ({ path: `${settings.checkout}/opencode/cmd/update/handoff.ts`, cwd: settings.checkout })

/** The handoff's program in the plugin tree `tree` of a build (`trees.ts`). */
export const treeProgram = (tree: string): Program => ({ path: `${tree}/opencode/cmd/update/handoff.ts`, cwd: `${tree}/opencode` })

/**
 * The handoff the record's next build runs (the staged build, else the installed one): its own, from
 * the tree beside its executable when it has one, so the restart, the health check and the recovery
 * are the target's code; else the live checkout's (the old scheme). `exists` is the file system's, but
 * for a test.
 */
export const programOf = (settings: Settings, recordText: Option.Option<string>, exists: (path: string) => boolean): Program =>
  Option.flatMap(recordText, parseRecord).pipe(
    Option.flatMap((record) => buildOf(promoted(record))),
    Option.map((build) => treeProgram(treeOf(build.command[0]))),
    Option.filter((program) => exists(program.path)),
    Option.getOrElse(() => checkoutProgram(settings)),
  )

/** `programOf` over the files: the record as it reads now, and whether the tree's handoff is there. */
const programNow = (settings: Settings) =>
  Effect.gen(function* () {
    const text = yield* readText(settings.record)
    const tree = Option.map(Option.flatMap(Option.flatMap(text, parseRecord), (record) => buildOf(promoted(record))), (build) => treeProgram(treeOf(build.command[0])).path)
    const there = yield* Effect.forEach(Option.toArray(tree), (path) => Effect.tryPromise(() => file(path).exists()).pipe(Effect.orElseSucceed(() => false)))
    return programOf(settings, text, () => there.includes(true))
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
