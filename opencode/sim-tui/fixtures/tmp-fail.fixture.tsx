// Run by sim-tui/tmp.test.ts as its own `bun test`, never by the suite: the
// simulated TUI with Prime loaded and one seeded test that fails, so the file
// ends red. Every folder the harness made is gone after it all the same.
import { expect } from "bun:test"
import { Effect } from "effect"
import * as App from "../app.ts"
import { stall, text } from "../server.ts"

const FILE = "sim-tui/fixtures/tmp-fail.fixture.tsx"
const BOOT: App.BootOptions = { file: FILE, plugins: ["cmd/prime"], width: 100, height: 24 }
const { seeded } = App.runner(FILE, 1)

App.bootTest(BOOT)

seeded("a seed that fails", ({ seed }) =>
  App.seed(BOOT, { key: "tmp-fail", seed, model: () => [text("Done."), stall] }, (tui) =>
    Effect.gen(function* () {
      yield* tui.settle
      expect(tui.text()).toContain("tmp-fail: a line no frame has")
    }),
  ),
)

App.closeTest()
