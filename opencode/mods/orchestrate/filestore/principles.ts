// The principle skills on disk, read at each call: every `<skills dir>/principle-*/SKILL.md`, by folder name.
// A directory that cannot be read, or a file that cannot, is left out. The read is synchronous: some forty small
// files, read in a few milliseconds, and an answer that never waits on the event loop (the simulated host's
// virtual clock included).
import { readdirSync, readFileSync } from "node:fs"
import { Array as Arr, Effect, Option } from "effect"
import { PREFIX, type PrincipleFile } from "../principles.ts"

/** A file's text, or none when it cannot be read. */
const textOf = (path: string): Option.Option<string> => Option.liftThrowable(() => readFileSync(path, "utf8"))()

/** `principle-<name>/SKILL.md` under `dir`: its folder name, path and text. */
export const read = (dir: string): Effect.Effect<ReadonlyArray<PrincipleFile>> =>
  Effect.sync(() => {
    const root = dir.replace(/\/+$/, "")
    const names = Option.getOrElse(Option.liftThrowable(() => readdirSync(root))(), (): ReadonlyArray<string> => [])
    return Arr.getSomes(
      names
        .filter((name) => name.startsWith(PREFIX))
        .map((id) => {
          const path = `${root}/${id}/SKILL.md`
          return Option.map(textOf(path), (text): PrincipleFile => ({ id, path, text }))
        }),
    )
  })
