// The documents a question's nudge names, those that exist: NORTH_STAR.md,
// AGENTS.md and CLAUDE.md in the asking session's directory and in its
// repository's root (the nearest ancestor holding `.git`). The principles are skills, named in
// words by the nudge (asking.ts `PRINCIPLES_NAMED`), not as a path. Paths are POSIX; `Look` says what exists
// (the file system's in OpenCode, a set in the tests).
import { Effect, Option } from "effect"

/** Whether a path exists. */
export interface Look {
  readonly exists: (path: string) => Effect.Effect<boolean>
}

/** The files looked for in each folder, in the order the nudge names them. */
export const FILES: ReadonlyArray<string> = ["NORTH_STAR.md", "AGENTS.md", "CLAUDE.md"]

/** `name` in `folder`. */
export const joined = (folder: string, name: string): string => `${folder.replace(/\/+$/, "")}/${name}`

/** The folder holding `path`; none at the root or for a relative path. */
export const parentOf = (path: string): Option.Option<string> => {
  const trimmed = path.replace(/\/+$/, "")
  const at = trimmed.lastIndexOf("/")
  return Option.liftPredicate(trimmed.slice(0, Math.max(at, 1)), () => at >= 0 && trimmed !== "")
}

/** The nearest folder from `directory` up that holds `.git`; none when no folder does. */
export const rootOf = Effect.fn("Documents.rootOf")(function* (look: Look, directory: string) {
  let folder = Option.some(directory)
  while (Option.isSome(folder)) {
    if (yield* look.exists(joined(folder.value, ".git"))) return folder
    folder = parentOf(folder.value)
  }
  return Option.none<string>()
})

/** The documents that exist for a session in `directory` (none known: ""). */
export const documents = Effect.fn("Documents.documents")(function* (look: Look, directory: string) {
  const root = yield* rootOf(look, directory)
  const folders = [...new Set([directory, ...Option.toArray(root)].filter((folder) => folder !== ""))]
  const candidates = folders.flatMap((folder) => FILES.map((file) => joined(folder, file)))
  return yield* Effect.filter(candidates, look.exists)
})
