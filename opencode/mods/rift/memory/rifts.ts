// Rifts held in memory, for the seam test and the model's tests: warm
// sources and their Rifts in a mutable world the test reads and changes, laid
// out as Rift lays them (`<parent>/.rifts/<source>/<name>`).
import { Effect, Layer } from "effect"
import { RiftFailed, Rifts, type CreateRequest } from "../service.ts"
import { holds, type Workspace } from "../workspace.ts"

export interface World {
  /** The warm sources, by directory. */
  readonly sources: Array<string>
  /** Each Rift, by its directory. */
  readonly rifts: Map<string, Workspace>
}

export const world = (sources: ReadonlyArray<string>, rifts: ReadonlyArray<Workspace> = []): World => ({
  sources: [...sources],
  rifts: new Map(rifts.map((workspace) => [workspace.path, workspace])),
})

/** Where Rift puts a Rift named `name` of `source`. */
export const pathOf = (source: string, name: string): string => {
  const parts = source.split("/")
  const base = parts.pop()
  return `${parts.join("/")}/.rifts/${base}/${name}`
}

/** A clean Rift on `branch`, as a test sets one up. */
export const clean = (path: string, branch: string | undefined): Workspace => ({
  path,
  source: false,
  children: [],
  git: true,
  branch,
  head: "abc1234",
  uncommitted: [],
  unpushed: [],
  stashes: 0,
})

const sourceOfRift = (state: World, path: string): string | undefined => state.sources.find((source) => path.startsWith(pathOf(source, "")))

export const layer = (state: World) =>
  Layer.succeed(
    Rifts,
    Rifts.of({
      source: Effect.fn("Rifts.source")(function* (directory: string) {
        const rift = [...state.rifts.keys()].find((path) => holds(path, directory))
        const source = rift === undefined ? state.sources.find((path) => holds(path, directory)) : sourceOfRift(state, rift)
        if (source === undefined) return yield* new RiftFailed({ operation: "rift ancestors", message: `${directory} is in no Rift source` })
        return source
      }),
      create: Effect.fn("Rifts.create")(function* (request: CreateRequest) {
        if (!state.sources.includes(request.source)) return yield* new RiftFailed({ operation: "rift create", message: `no initialized workspace at ${request.source}` })
        const path = pathOf(request.source, request.name)
        if (state.rifts.has(path)) return yield* new RiftFailed({ operation: "rift create", message: `rift directory already exists: ${path}` })
        state.rifts.set(path, clean(path, request.branch))
        return path
      }),
      list: Effect.fn("Rifts.list")(function* (source: string) {
        return [...state.rifts.keys()].filter((path) => sourceOfRift(state, path) === source).sort()
      }),
      inspect: Effect.fn("Rifts.inspect")(function* (path: string) {
        if (state.sources.includes(path)) return { ...clean(path, "main"), source: true, children: [...state.rifts.keys()].filter((rift) => sourceOfRift(state, rift) === path) }
        const workspace = state.rifts.get(path)
        if (workspace === undefined) return yield* new RiftFailed({ operation: "rift", message: `${path} is not a Rift workspace (no .rift marker)` })
        return workspace
      }),
      remove: Effect.fn("Rifts.remove")(function* (path: string) {
        if (!state.rifts.delete(path)) return yield* new RiftFailed({ operation: "rift remove", message: `${path} is not a Rift workspace` })
      }),
    }),
  )

/** Changes a Rift in place, as work in it would. */
export const change = (state: World, path: string, update: (workspace: Workspace) => Workspace): void => {
  const workspace = state.rifts.get(path)
  if (workspace !== undefined) state.rifts.set(path, update(workspace))
}
