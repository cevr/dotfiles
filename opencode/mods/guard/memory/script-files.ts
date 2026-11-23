// ScriptFiles held in memory: the scripts a test puts on its stand-in disk, by
// their absolute paths; any other path holds none.
import { Effect, Layer, Option } from "effect"
import { ScriptFiles } from "../service.ts"

/** Each script's text, by its absolute path. */
export type World = Readonly<Record<string, string>>

export const layer = (world: World = {}) =>
  Layer.succeed(
    ScriptFiles,
    ScriptFiles.of({
      text: (path) => Effect.succeed(Option.filter(Option.some(path), (each) => Object.hasOwn(world, each)).pipe(Option.map((each) => `${world[each]}`))),
    }),
  )
