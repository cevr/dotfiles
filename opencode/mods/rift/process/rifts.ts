// Rifts over the `rift` CLI and Git, run as child processes. With
// `workrift: true` (the workbox, where it is on PATH) a Rift is made and
// removed by `workrift`, which refreshes the warm source, checks out the
// branch and carries over gh stack metadata; everything else asks `rift` and
// `git` directly, on either machine. A command that fails is a RiftFailed
// carrying what it printed.
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect, Layer } from "effect"
import { RiftFailed, Rifts, type CreateRequest } from "../service.ts"
import type { Workspace } from "../workspace.ts"
import { commands, lines } from "./command.ts"

export interface Options {
  /** Make and remove Rifts with `workrift` (the workbox). */
  readonly workrift: boolean
  /** Variables added to every command's environment (a test's scratch HOME). */
  readonly env?: Readonly<Record<string, string>>
}

export const layer = (options: Options) => {
  const { spawn, run } = commands(options.env)

  const git = (path: string, ...args: ReadonlyArray<string>) => run(["git", "-C", path, ...args], path)

  /** Where a directory that may not exist yet can run a command from: its nearest existing ancestor. */
  const existing = (path: string): string => (existsSync(path) || path === "/" ? path : existing(dirname(path)))

  /** The Rift roots above `path`, nearest first; empty for a root. */
  const ancestors = (path: string) => run(["rift", "ancestors", path], existing(path)).pipe(Effect.map(lines))

  const source = Effect.fn("Rifts.source")(function* (directory: string) {
    const top = yield* git(directory, "rev-parse", "--show-toplevel").pipe(
      Effect.map((out) => out.trim()),
      Effect.orElseSucceed(() => directory),
    )
    const above = yield* Effect.result(ancestors(top))
    if (above._tag === "Success") return above.success.at(-1) ?? top
    if (options.workrift) {
      // A plain checkout: workrift finds the warm source with the same origin.
      const out = yield* run(["workrift", "check"], top)
      const found = /Warm source checks passed: (.+)$/m.exec(out)?.[1]
      if (found !== undefined) return found.trim()
    }
    return yield* new RiftFailed({
      operation: "rift ancestors",
      message: `${top} is in no Rift source (${above.failure.message}). The owner makes a repository a warm source with \`rift init\` (Mac) or \`workrift init\` (workbox).`,
    })
  })

  /** Checks out `branch` in a fresh Rift: the local branch, else the remote one, else a new branch from HEAD. */
  const checkout = (path: string, branch: string) =>
    Effect.gen(function* () {
      const has = (ref: string) => spawn(["git", "-C", path, "show-ref", "--verify", "--quiet", ref], path).pipe(Effect.map((ran) => ran.code === 0))
      if (yield* has(`refs/heads/${branch}`)) return yield* git(path, "switch", branch)
      if (yield* has(`refs/remotes/origin/${branch}`)) return yield* git(path, "switch", "--track", "-c", branch, `origin/${branch}`)
      return yield* git(path, "switch", "--no-track", "-c", branch)
    }).pipe(Effect.mapError((error) => new RiftFailed({ operation: error.operation, message: `the Rift ${path} was made, but ${error.message}` })))

  const create = Effect.fn("Rifts.create")(function* (request: CreateRequest) {
    if (options.workrift) {
      // From the caller's checkout, so workrift imports its gh stack metadata; the source is named outright.
      const out = yield* run(["workrift", "create", request.branch], existing(request.from), { WORKRIFT_SOURCE: request.source })
      const path = lines(out).at(-1)
      if (path === undefined) return yield* new RiftFailed({ operation: "workrift create", message: "it printed no workspace path" })
      return path
    }
    const out = yield* run(["rift", "create", request.source, "--copy-all", "--name", request.name], request.source)
    const path = lines(out).at(-1)
    if (path === undefined) return yield* new RiftFailed({ operation: "rift create", message: "it printed no workspace path" })
    yield* checkout(path, request.branch)
    return path
  })

  const list = Effect.fn("Rifts.list")(function* (from: string) {
    return yield* run(["rift", "list", from], from).pipe(Effect.map(lines))
  })

  const inspect = Effect.fn("Rifts.inspect")(function* (path: string) {
    // `rift` walks up to the nearest workspace; only a workspace's own root holds its marker.
    if (!existsSync(join(path, ".rift"))) return yield* new RiftFailed({ operation: "rift", message: `${path} is not a Rift workspace (no .rift marker)` })
    const above = yield* ancestors(path)
    const children = yield* list(path)
    const isGit = (yield* spawn(["git", "-C", path, "rev-parse", "--is-inside-work-tree"], path)).code === 0
    const base = { path, source: above.length === 0, children }
    if (!isGit) return { ...base, git: false, branch: undefined, head: "", uncommitted: [], unpushed: [], stashes: 0 } satisfies Workspace
    const branch = (yield* git(path, "branch", "--show-current")).trim()
    const head = yield* git(path, "rev-parse", "--short", "HEAD").pipe(
      Effect.map((out) => out.trim()),
      Effect.orElseSucceed(() => "(no commits)"),
    )
    const uncommitted = lines(yield* git(path, "status", "--porcelain", "--", ".", ":(exclude).rift"))
    // Commits found only here: on no remote, and in no branch of the warm source it was copied from.
    const root = above.at(-1)
    const sourceTips = root === undefined ? [] : lines(yield* git(root, "for-each-ref", "--format=%(objectname)", "refs/heads"))
    const hasHead = head !== "(no commits)"
    const unpushed = lines(
      yield* git(path, "log", "--format=%h %s", ...(hasHead ? ["HEAD"] : []), "--branches", "--ignore-missing", "--not", "--remotes", ...sourceTips),
    )
    const stashes = lines(yield* git(path, "stash", "list")).length
    return { ...base, git: true, branch: branch === "" ? undefined : branch, head, uncommitted, unpushed, stashes } satisfies Workspace
  })

  const remove = Effect.fn("Rifts.remove")(function* (path: string, removeOptions?: { readonly withChildren?: boolean }) {
    const from = existing(dirname(path))
    // `rift remove` always trashes the subtree; workrift asks for --with-children first.
    yield* options.workrift
      ? run(["workrift", "remove", ...(removeOptions?.withChildren === true ? ["--with-children"] : []), path], from)
      : run(["rift", "remove", path], from)
  })

  return Layer.succeed(Rifts, Rifts.of({ source, create, list, inspect, remove }))
}
