// Workbox held in memory: with `available`, each command answers a line
// naming it, where it ran and its source, and is kept for the test; without,
// each fails NotOnWorkbox, as on the Mac.
import { Effect, Layer } from "effect"
import { NotOnWorkbox, Workbox, type WorkboxCommand } from "../service.ts"

export interface Ran {
  readonly command: WorkboxCommand
  readonly cwd: string
  readonly source: string | undefined
}

export const layer = (available: boolean, ran: Array<Ran> = []) =>
  Layer.succeed(
    Workbox,
    Workbox.of({
      run: (command, cwd, source) =>
        available
          ? Effect.sync(() => {
              ran.push({ command, cwd, source })
              return `ran ${command._tag} in ${cwd}${source === undefined ? "" : ` for ${source}`}\n`
            })
          : Effect.fail(new NotOnWorkbox({ command: command._tag })),
    }),
  )
