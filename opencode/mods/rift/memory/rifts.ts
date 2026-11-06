// Rifts held in memory, for the seam test and the model's tests: warm
// sources and their Rifts in a mutable world the test reads and changes, laid
// out as Rift lays them (`<parent>/.rifts/<source>/<name>`).
import { Effect, Layer } from "effect"
import { RiftFailed, Rifts, type CreateRequest } from "../service.ts"
import { holds, ownStashes, type Workspace } from "../workspace.ts"

export interface World {
  /** The warm sources, by directory. */
  readonly sources: Array<string>
  /** Each Rift, by its directory. */
  readonly rifts: Map<string, Workspace>
  /**
   * Each workspace's stash commits (`stash`), sources and Rifts alike. A Rift
   * made from a source starts with a copy of the source's; `inspect` counts
   * the ones its source does not also hold on top of the `stashes` a test set.
   */
  readonly stashed: Map<string, ReadonlyArray<string>>
}

export const world = (sources: ReadonlyArray<string>, rifts: ReadonlyArray<Workspace> = []): World => ({
  sources: [...sources],
  rifts: new Map(rifts.map((workspace) => [workspace.path, workspace])),
  stashed: new Map(),
})

/** Stashes a change in the workspace at `path` (a source or a Rift), as `git stash` there would: a new commit atop its stash. */
export const stash = (state: World, path: string, commit: string): void => {
  state.stashed.set(path, [commit, ...(state.stashed.get(path) ?? [])])
}

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
        // A copy-on-write copy: the source's stash comes with it.
        state.stashed.set(path, [...(state.stashed.get(request.source) ?? [])])
        return path
      }),
      list: Effect.fn("Rifts.list")(function* (source: string) {
        return [...state.rifts.keys()].filter((path) => sourceOfRift(state, path) === source).sort()
      }),
      inspect: Effect.fn("Rifts.inspect")(function* (path: string) {
        if (state.sources.includes(path)) return { ...clean(path, "main"), source: true, children: [...state.rifts.keys()].filter((rift) => sourceOfRift(state, rift) === path) }
        const workspace = state.rifts.get(path)
        if (workspace === undefined) return yield* new RiftFailed({ operation: "rift", message: `${path} is not a Rift workspace (no .rift marker)` })
        const source = sourceOfRift(state, path)
        const own = ownStashes(state.stashed.get(path) ?? [], source === undefined ? [] : (state.stashed.get(source) ?? []))
        return own === 0 ? workspace : { ...workspace, stashes: workspace.stashes + own }
      }),
      remove: Effect.fn("Rifts.remove")(function* (path: string, options?: { readonly withChildren?: boolean }) {
        const workspace = state.rifts.get(path)
        if (workspace === undefined) return yield* new RiftFailed({ operation: "rift remove", message: `${path} is not a Rift workspace` })
        if (workspace.children.length > 0 && options?.withChildren !== true)
          return yield* new RiftFailed({ operation: "workrift remove", message: `${path} has child workspaces; pass --with-children to trash them too` })
        // Rift trashes the whole subtree.
        const drop = (each: string): void => {
          for (const child of state.rifts.get(each)?.children ?? []) drop(child)
          state.rifts.delete(each)
          state.stashed.delete(each)
        }
        drop(path)
      }),
    }),
  )

/** Changes a Rift in place, as work in it would. */
export const change = (state: World, path: string, update: (workspace: Workspace) => Workspace): void => {
  const workspace = state.rifts.get(path)
  if (workspace !== undefined) state.rifts.set(path, update(workspace))
}
