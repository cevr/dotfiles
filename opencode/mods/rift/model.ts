// The rift tool's handler: it reads where the calling session runs, finds the
// warm source, and creates, lists or removes Rifts through the Rifts
// contract, removing only what `removal` (workspace.ts) allows. The plugin
// calls this and nothing else.
import { Context, Effect, Layer } from "effect"
import { BranchMissing, NoSuchRift, TargetMissing, baseName, created, listed, removed, workspaceName, type InputRefused, type RiftInput } from "./rift.ts"
import { Rifts, SessionDirectories, type RiftFailed, type SessionUnreadable } from "./service.ts"
import { removal, type RemoveRefused, type Workspace } from "./workspace.ts"

/** `path` against `directory`, with `.` and `..` folded. */
export const resolvePath = (directory: string, path: string): string => {
  const parts: Array<string> = []
  for (const part of (path.startsWith("/") ? path : `${directory}/${path}`).split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return `/${parts.join("/")}`
}

/** One answer: the text the model reads and what the transcript keeps. */
export interface Answer {
  readonly text: string
  readonly metadata: {
    readonly action: RiftInput["action"]
    readonly source: string
    readonly path?: string
    readonly branch?: string
  }
}

export type Failure = InputRefused | RemoveRefused | RiftFailed | SessionUnreadable

export class RiftTool extends Context.Service<
  RiftTool,
  {
    /** Acts on one call of the tool from `sessionID`. */
    readonly run: (sessionID: string, input: RiftInput) => Effect.Effect<Answer, Failure>
  }
>()("dotfiles-opencode/rift/RiftTool") {}

export const layer = Layer.effect(
  RiftTool,
  Effect.gen(function* () {
    const rifts = yield* Rifts
    const sessions = yield* SessionDirectories

    const create = Effect.fn("RiftTool.create")(function* (directory: string, source: string, input: RiftInput) {
      const branch = input.branch ?? input.name
      if (branch === undefined || branch.trim() === "") return yield* new BranchMissing()
      const name = input.name ?? workspaceName(branch)
      const path = yield* rifts.create({ source, from: directory, name, branch })
      const workspace = yield* rifts.inspect(path)
      return {
        text: created(workspace, source),
        metadata: { action: "create" as const, source, path, ...(workspace.branch === undefined ? {} : { branch: workspace.branch }) },
      }
    })

    const list = Effect.fn("RiftTool.list")(function* (source: string) {
      const workspaces: ReadonlyArray<Workspace> = yield* Effect.forEach(yield* rifts.list(source), rifts.inspect, { concurrency: 4 })
      return { text: listed(source, workspaces), metadata: { action: "list" as const, source } }
    })

    const remove = Effect.fn("RiftTool.remove")(function* (directory: string, source: string, input: RiftInput) {
      const target = yield* Effect.gen(function* () {
        if (input.path !== undefined) return resolvePath(directory, input.path)
        if (input.name === undefined) return yield* new TargetMissing()
        const name = input.name
        const paths = yield* rifts.list(source)
        const match = paths.find((path) => baseName(path) === name) ?? paths.find((path) => baseName(path) === workspaceName(name))
        if (match === undefined) return yield* new NoSuchRift({ name, source, rifts: [...paths] })
        return match
      })
      const workspace = yield* rifts.inspect(target)
      yield* removal(workspace, { force: input.force === true, sessionDirectory: directory })
      yield* rifts.remove(workspace.path)
      return {
        text: removed(workspace),
        metadata: { action: "remove" as const, source, path: workspace.path, ...(workspace.branch === undefined ? {} : { branch: workspace.branch }) },
      }
    })

    const run = Effect.fn("RiftTool.run")(function* (sessionID: string, input: RiftInput) {
      const directory = yield* sessions.directoryOf(sessionID)
      const source = yield* rifts.source(input.source === undefined ? directory : resolvePath(directory, input.source))
      switch (input.action) {
        case "create":
          return yield* create(directory, source, input)
        case "list":
          return yield* list(source)
        case "remove":
          return yield* remove(directory, source, input)
      }
    })

    return RiftTool.of({ run })
  }),
)

/** What the model reads when a call fails. */
export const failureText = (failure: RiftFailed | SessionUnreadable): string =>
  failure._tag === "RiftFailed" ? `${failure.operation} failed: ${failure.message}` : `Cannot tell where this session runs (${failure.message}).`
