// Fixture cgroup trees for the Linux supply reads (process/admission.ts),
// served from memory through a FileSystem that knows only the tree's files:
// the workbox as read on 2026-11-25 (fixtures/cgroup-workbox.json) and the
// same host provisioned (fixtures/cgroup-provisioned.json laid over it).
import { Effect, FileSystem, Option } from "effect"
import workboxTree from "../fixtures/cgroup-workbox.json"
import provisionedTree from "../fixtures/cgroup-provisioned.json"
import type { LinuxSources } from "./admission.ts"

export interface Tree {
  readonly slices: Readonly<Record<string, string>>
  readonly files: Readonly<Record<string, string>>
}
export const ROOT = "/fixture/sys/fs/cgroup"
export const USER = `${ROOT}/user.slice/user-1000.slice/user@1000.service`
const GiB = 2 ** 30

export const fileSystemOf = (tree: Tree) => {
  const none = FileSystem.makeNoop({})
  const paths = Object.keys(tree.files)
  return FileSystem.makeNoop({
    readFileString: (path) => Option.match(Option.fromNullishOr(tree.files[path]), {
      onNone: () => none.readFileString(path),
      onSome: (text) => Effect.succeed(text),
    }),
    exists: (path) => Effect.succeed(paths.some((file) => file === path || file.startsWith(`${path}/`))),
    readDirectory: (path) => {
      const names = new Set(paths.filter((file) => file.startsWith(`${path}/`)).map((file) => file.slice(path.length + 1).split("/")[0] ?? ""))
      if (names.size === 0) return none.readDirectory(path)
      return Effect.succeed([...names])
    },
  })
}

/** The tree's sources: a 4-processor, 8 GiB host where no file says. */
export const sourcesOf = (tree: Tree): LinuxSources => ({
  cgroupRoot: ROOT, proc: "/fixture/proc", cpuOnline: "/fixture/sys/devices/system/cpu/online",
  processors: 4, memoryBytes: 8 * GiB,
  slice: (unit) => Effect.succeed(Option.fromNullishOr(tree.slices[unit])),
})

/** `effect` on `tree`'s sources, its reads served by `tree` alone. */
export const run = <A, E>(tree: Tree, effect: (sources: LinuxSources) => Effect.Effect<A, E, FileSystem.FileSystem>) =>
  effect(sourcesOf(tree)).pipe(Effect.provideService(FileSystem.FileSystem, fileSystemOf(tree)))

export const WORKBOX: Tree = workboxTree
export const PROVISIONED: Tree = {
  slices: { ...workboxTree.slices, ...provisionedTree.slices },
  files: { ...workboxTree.files, ...provisionedTree.files },
}

/** `tree` with `files` written over it. */
export const withFiles = (tree: Tree, files: Readonly<Record<string, string>>): Tree =>
  ({ slices: tree.slices, files: { ...tree.files, ...files } })
/** `tree` without the files `gone` names. */
export const withoutFiles = (tree: Tree, gone: ReadonlySet<string>): Tree =>
  ({ slices: tree.slices, files: Object.fromEntries(Object.entries(tree.files).filter(([file]) => !gone.has(file))) })
