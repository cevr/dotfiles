// Rifts over the `rift` CLI and Git, run as child processes. With
// `workrift: true` (the workbox, where it is on PATH) a Rift is made and
// removed by `workrift`, which refreshes the warm source, checks out the
// branch and carries over gh stack metadata; everything else asks `rift` and
// `git` directly, on either machine. A command that fails is a RiftFailed
// carrying what it printed.
import { constants, copyFileSync, existsSync, readdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect, Layer, Option } from "effect"
import { RiftFailed, Rifts, type CreateRequest } from "../service.ts"
import { ownStashes, type Workspace } from "../workspace.ts"
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

  /** The absolute path of `objects/pack` in the repository at `path`. */
  const packDirectory = (path: string) =>
    git(path, "rev-parse", "--path-format=absolute", "--git-path", "objects/pack").pipe(Effect.map((out) => out.trim()))

  /**
   * Gives a new Rift every pack its copy dropped. `rift create` copies the source with one
   * `clonefile` of its directory, which APFS clones as if file by file (its man page discourages
   * it): on 2026-11-12 Rift after Rift came out without a pack the source held, while the
   * multi-pack index the copy did carry still named it, and Git then read no object of it, so
   * the branch switch failed. Every complete pack of the source (its `.idx` written last, so
   * a fetch still writing one is skipped) the Rift lacks is cloned again; a multi-pack index
   * that still fails Git's own check names a pack found nowhere, and is written again from the
   * packs there are.
   */
  const restorePacks = Effect.fn("Rifts.restorePacks")(function* (path: string, source: string) {
    const from = yield* packDirectory(source)
    const to = yield* packDirectory(path)
    const held = new Set(readdirSync(to))
    const complete = new Set(
      readdirSync(from)
        .filter((file) => /^pack-[0-9a-f]+\.idx$/.test(file))
        .map((file) => file.slice(0, -".idx".length)),
    )
    const dropped = readdirSync(from)
      .filter((file) => complete.has(file.slice(0, file.lastIndexOf("."))) && !file.endsWith(".keep") && !held.has(file))
      // The `.idx` last: Git takes a pack as there once its index is.
      .sort((a, b) => Number(a.endsWith(".idx")) - Number(b.endsWith(".idx")))
    yield* Effect.try({
      try: () => {
        for (const file of dropped) copyFileSync(join(from, file), join(to, file), constants.COPYFILE_FICLONE)
      },
      catch: (cause) => new RiftFailed({ operation: "restore packs", message: `the Rift ${path} was made, but ${String(cause)}` }),
    })
    const midx = join(to, "multi-pack-index")
    if (existsSync(midx) && (yield* spawn(["git", "-C", path, "multi-pack-index", "verify", "--no-progress"], path)).code !== 0) {
      rmSync(midx, { force: true })
      yield* spawn(["git", "-C", path, "multi-pack-index", "write", "--no-progress"], path)
    }
  })

  /** Whether `at` names a commit in the checkout at `path`. */
  const hasCommit = (path: string, at: string) =>
    spawn(["git", "-C", path, "rev-parse", "--verify", "--quiet", `${at}^{commit}`], path).pipe(Effect.map((ran) => ran.code === 0))

  /**
   * Detaches a fresh Rift at `at`, fetching origin first when it lacks the commit (and asking origin for its default
   * branch when `at` is `origin/HEAD`). A detach that fails removes the Rift, so no half-made one is left.
   */
  const detach = (path: string, at: string) =>
    Effect.gen(function* () {
      if (!(yield* hasCommit(path, at))) {
        yield* spawn(["git", "-C", path, "fetch", "--quiet", "origin"], path)
        if (at === "origin/HEAD") yield* spawn(["git", "-C", path, "remote", "set-head", "origin", "--auto"], path)
      }
      if (!(yield* hasCommit(path, at))) return yield* new RiftFailed({ operation: "git switch", message: `no commit ${at} here or on origin` })
      yield* git(path, "switch", "--quiet", "--detach", at)
    }).pipe(
      Effect.catch((error: RiftFailed) =>
        remove(path).pipe(
          Effect.ignore,
          Effect.andThen(Effect.fail(new RiftFailed({ operation: error.operation, message: `the Rift ${path} was removed: ${error.message}` }))),
        ),
      ),
    )

  const create = Effect.fn("Rifts.create")(function* (request: CreateRequest) {
    if (options.workrift) {
      // From the caller's checkout, so workrift imports its gh stack metadata; the source is named outright.
      const out = yield* run(["workrift", "create", request.branch], existing(request.from), { WORKRIFT_SOURCE: request.source })
      const path = lines(out).at(-1)
      if (path === undefined) return yield* new RiftFailed({ operation: "workrift create", message: "it printed no workspace path" })
      yield* Option.match(Option.fromUndefinedOr(request.at), { onNone: () => Effect.void, onSome: (at) => detach(path, at) })
      return path
    }
    const out = yield* run(["rift", "create", request.source, "--copy-all", "--name", request.name], request.source)
    const path = lines(out).at(-1)
    if (path === undefined) return yield* new RiftFailed({ operation: "rift create", message: "it printed no workspace path" })
    if (existsSync(join(path, ".git"))) yield* restorePacks(path, request.source)
    yield* Option.match(Option.fromUndefinedOr(request.at), { onNone: () => Effect.asVoid(checkout(path, request.branch)), onSome: (at) => detach(path, at) })
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
    // Stash entries found only here: a Rift inherits the stash of the workspaces it was copied from.
    const stashOf = (at: string) => git(at, "stash", "list", "--format=%H").pipe(Effect.map(lines))
    const inherited = yield* Effect.forEach(above, stashOf).pipe(Effect.map((each) => each.flat()))
    const stashes = ownStashes(yield* stashOf(path), inherited)
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
