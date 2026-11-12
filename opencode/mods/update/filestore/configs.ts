import { Effect, Layer, Option } from "effect"
import { Configs } from "../service.ts"
import { readText, remove, writeText } from "./files.ts"

/** The config files a stage writes (`~/.config/opencode`), and where the replaced ones are kept. */
export interface Paths {
  readonly config: ReadonlyArray<string>
  readonly kept: string
}

const keptOf = (paths: Paths, path: string): string => `${paths.kept}/${path.split("/").at(-1) ?? path}`

/**
 * Configs over the files: keep copies them aside (a file absent then has no copy), restore puts the
 * copies back and leaves a file with no copy as it is.
 */
export const layer = (paths: Paths) =>
  Layer.succeed(
    Configs,
    Configs.of({
      keep: Effect.forEach(
        paths.config,
        (path) =>
          readText(path).pipe(
            Effect.flatMap((text) =>
              Option.match(text, { onNone: () => remove(keptOf(paths, path)), onSome: (each) => writeText("keep the config", keptOf(paths, path), each) }),
            ),
          ),
        { discard: true },
      ),
      restore: Effect.forEach(
        paths.config,
        (path) =>
          readText(keptOf(paths, path)).pipe(
            Effect.flatMap((text) => Option.match(text, { onNone: () => Effect.void, onSome: (each) => writeText("restore the config", path, each) })),
          ),
        { discard: true },
      ),
    }),
  )
