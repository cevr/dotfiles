// A boot that fails its check (past its CPU, here a limit of 0 ms) closes the app it started: the file's next boot
// (its first seed's) starts a fresh app, alone, and the seed drives that app. Before, the failed boot's app stayed
// up: the next boot saw the old app's route plugin, took it for its own, and the seed navigated the old app while the
// frames came from the new one, so a seed after a slow boot waited on the lobby (model-next-tui at load 38).
import { expect } from "bun:test"
import { Effect, Option } from "effect"
import * as App from "./app.ts"
import { router } from "./route/registry.ts"
import { type Model, text } from "./server.ts"

const FILE = "sim-tui/boot-fail.test.tsx"
const BOOT: App.BootOptions = { file: FILE, plugins: ["cmd/prime"], width: 100, height: 30 }
const model: Model = ({ step }) => [[text("Done.")]][step] ?? []

App.effectTest(
  "a boot past its CPU fails, saying so, and closes its app: no route plugin's navigate is left for the next boot",
  Effect.flip(App.bootWithin(BOOT, 0)).pipe(
    Effect.map((error) => {
      expect(error.message).toContain("past the 0 ms of CPU a boot has")
      expect(Option.isNone(router().navigate)).toBe(true)
    }),
  ),
  App.BOOT_TIMEOUT_MS,
)

App.effectTest(
  "after it, a seed boots a fresh app and drives it: the session it opens is the one on screen",
  App.seed(BOOT, { key: "boot-fail", seed: 1, model }, (tui) =>
    Effect.gen(function* () {
      const opened = tui.server.session({ title: "After the failed boot" })
      yield* tui.navigate(opened)
      yield* tui.until("the opened session", (shown) => shown.join("\n").includes("After the failed boot"))
    }),
  ),
  App.BOOT_TIMEOUT_MS,
)

App.closeTest()
