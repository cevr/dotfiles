// Finding the Rift an input names among a warm source's: by path (absolute,
// or against the session's directory), else by its directory name or its
// branch. On the workbox `workrift create <branch>` names a Rift after its
// branch, so a caller that knows the branch, or a Rift moved to another
// branch since, still finds it. Exact matches first (the name, `/` folded to
// `-` as Rift names it, or the branch), then the branch with `/` as `-`; two
// Rifts at one step fail AmbiguousRift naming both, never a guess.
import { Effect } from "effect"
import { AmbiguousRift, NoSuchRift, baseName, workspaceName } from "./rift.ts"
import { Rifts } from "./service.ts"

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

/** Whether `target` names a path rather than a Rift: it starts with `/` or `.`. */
export const isPath = (target: string): boolean => target.startsWith("/") || target.startsWith(".")

/** The Rift of `source` that `target` names: a path, else a Rift name or branch. */
export const findRift = Effect.fn("findRift")(function* (directory: string, source: string, target: string) {
  if (isPath(target)) return resolvePath(directory, target)
  const rifts = yield* Rifts
  const paths = yield* rifts.list(source)
  // A Rift that cannot be read (no Git checkout) has no branch to match; it is still found by name.
  const branches = yield* Effect.forEach(paths, (path) => rifts.inspect(path).pipe(Effect.map((workspace) => workspace.branch), Effect.orElseSucceed(() => undefined)), {
    concurrency: 4,
  })
  const branchOf = (path: string) => branches[paths.indexOf(path)]
  const shown = (path: string) => `${path} (${branchOf(path) === undefined ? "no branch" : `branch ${branchOf(path)}`})`
  const steps: ReadonlyArray<(path: string) => boolean> = [
    (path) => baseName(path) === target || baseName(path) === workspaceName(target) || branchOf(path) === target,
    (path) => branchOf(path)?.replaceAll("/", "-") === target,
  ]
  for (const step of steps) {
    const matches = paths.filter(step)
    if (matches.length === 1) return matches[0]!
    if (matches.length > 1) return yield* new AmbiguousRift({ name: target, source, matches: matches.map(shown) })
  }
  return yield* new NoSuchRift({ name: target, source, rifts: paths.map(shown) })
})
