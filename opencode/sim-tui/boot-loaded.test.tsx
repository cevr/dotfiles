// A boot past its CPU on a loaded host passes, reported and not judged: on a host past its cores the same boot
// takes more CPU (sim/seed.ts `cpuVerdict`), and a deep run at load 40-51 failed three files on boots of 4.0-4.3 s
// that took 2.7-3.0 s at load 8. The app it booted is the file's: a seed drives it.
import { expect } from "bun:test"
import { Effect, Option } from "effect"
import * as App from "./app.ts"
import { router } from "./route/registry.ts"
import { type Model, text } from "./server.ts"

const FILE = "sim-tui/boot-loaded.test.tsx"
const BOOT: App.BootOptions = { file: FILE, plugins: ["cmd/prime"], width: 100, height: 30 }
const model: Model = ({ step }) => [[text("Done.")]][step] ?? []

App.effectTest(
  "a boot past its CPU on a loaded host passes, reported, not judged",
  App.bootWithin(BOOT, 0, Effect.succeed({ load: 48, cores: 12 })).pipe(
    Effect.map((app) => {
      expect(app.options.file).toBe(FILE)
      expect(Option.isSome(router().navigate)).toBe(true)
    }),
  ),
  App.BOOT_TIMEOUT_MS,
)

App.effectTest(
  "a seed drives the app that boot started",
  App.seed(BOOT, { key: "boot-loaded", seed: 1, model }, (tui) =>
    Effect.gen(function* () {
      const opened = tui.server.session({ title: "After the loaded boot" })
      yield* tui.navigate(opened)
      yield* tui.until("the opened session", (shown) => shown.join("\n").includes("After the loaded boot"))
    }),
  ),
  App.BOOT_TIMEOUT_MS,
)

App.closeTest()
