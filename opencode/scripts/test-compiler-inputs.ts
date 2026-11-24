import { Effect, Path } from "effect"
import { API } from "typescript/unstable/async"

type Projects = Readonly<Record<string, ReadonlyArray<string>>>
export type CompilerInputs = ReadonlyMap<string, ReadonlySet<string>>

/** Ask TypeScript for its own source census once per checkout snapshot, not once per changed file. */
export const compilerInputs = (root: string, inputs: ReadonlySet<string>, projects: Projects = {}) =>
  Effect.gen(function* () {
    const configs = [...new Set(Object.values(projects).flat())].filter((file) => inputs.has(file))
    if (configs.length === 0) return new Map<string, ReadonlySet<string>>()
    const path = yield* Path.Path
    const client = yield* Effect.acquireRelease(
      Effect.try(() => new API({ cwd: root })),
      (opened) => Effect.tryPromise(() => opened.close()).pipe(Effect.ignore),
    )
    const snapshot = yield* Effect.tryPromise(() => client.updateSnapshot({ openProjects: configs.map((file) => path.join(root, file)) }))
    const entries = yield* Effect.forEach(snapshot.getProjects(), (project) =>
      Effect.tryPromise(() => project.program.getSourceFileNames()).pipe(Effect.map((files) => {
        const config = path.relative(root, project.configFileName)
        const sources = files.map((file) => path.relative(root, file)).filter((file) => inputs.has(file))
        return [config, new Set([config, ...sources])] as const
      })),
    )
    return new Map(entries)
  }).pipe(Effect.scoped, Effect.provide(Path.layer), Effect.orElseSucceed(() => new Map<string, ReadonlySet<string>>()), Effect.runPromise)

/** The runner is the owner of its observed projects. Missing native answers make it uncertain, not empty. */
export const projectReads = (configs: ReadonlyArray<string>, projects?: CompilerInputs) => {
  const ready = configs.every((config) => projects?.has(config))
  const exact = new Set(configs.flatMap((config) => [...(projects?.get(config) || [])]))
  return { exact, ready }
}
