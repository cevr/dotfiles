import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { Data, Effect, FileSystem, Option, Schedule } from "effect"
import { hostCall, type HostScreen } from "../pty-host.ts"
import { seenPath } from "./tui.ts"

class ComposerUnavailable extends Data.TaggedError("ComposerUnavailable")<{ readonly message: string }> {}

const pty = <A>(read: () => Promise<A>) =>
  Effect.tryPromise({
    try: read,
    catch: (cause) => {
      if (cause instanceof Error) return cause
      return new ComposerUnavailable({ message: String(cause) })
    },
  })

/** The screen at the waiter's last look, for its failure message. */
interface LastScreen {
  rows: ReadonlyArray<string>
}

const poll = Effect.fn("Gamut.composerReady")(function* (marker: string, readScreen: () => Promise<HostScreen>, last: LastScreen) {
  const fs = yield* FileSystem.FileSystem
  if (yield* fs.exists(marker)) return true
  const screen = yield* pty(readScreen)
  last.rows = screen.rows
  const exit = Option.fromUndefinedOr(screen.exited)
  if (Option.isSome(exit))
    return yield* new ComposerUnavailable({ message: `OpenCode exited ${exit.value} before its default agent was ready` })
  return false
})

/** What the startup plugin last saw, or that it never looked. */
const lastLook = Effect.fn("Gamut.composerLastLook")(function* (marker: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(seenPath(marker)).pipe(
    Effect.map((text) => text.trim()),
    Effect.orElseSucceed(() => "nothing: the startup plugin never looked"),
  )
})

/** The pty socket can answer before the TUI has the plugin's default agent or its model. */
export const waitForComposer = (marker: string, agent: string, readScreen: () => Promise<HostScreen>): Promise<void> => {
  const last: LastScreen = { rows: [] }
  return Effect.runPromise(
    poll(marker, readScreen, last).pipe(
      Effect.repeat({ until: (ready) => ready, schedule: Schedule.spaced("50 millis") }),
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () =>
          Effect.flatMap(lastLook(marker), (look) =>
            Effect.fail(
              new ComposerUnavailable({
                message: [
                  `OpenCode did not present the registered ${agent} as its default agent with a model; no prompt was sent`,
                  `composer saw: ${look}`,
                  "screen:",
                  ...last.rows.filter((row) => row.trim() !== ""),
                ].join("\n"),
              }),
            ),
          ),
      }),
      Effect.asVoid,
      Effect.provide(BunFileSystem.layer),
    ),
  )
}

const typePrompt = Effect.fn("Gamut.submit")(function* (socket: string, text: string) {
  yield* pty(() => hostCall(socket, { op: "type", text }))
  yield* pty(() => hostCall(socket, { op: "keys", names: ["enter"] }))
})

export const submit = (socket: string, text: string): Promise<void> => Effect.runPromise(typePrompt(socket, text))
