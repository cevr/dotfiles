// Run by sim-tui/host.test.ts as its own `bun test`, never by the suite: the
// simulated TUI with Prime loaded, one seed, its frame at rest printed line by
// line (`host-frame|`). host.test.ts runs it on a fake host whose HOME and
// XDG_STATE_HOME hold an upstream reading; the harness points every dir our
// plugins read into its own scratch, so the frame never shows that reading.
import { Console, Effect } from "effect"
import * as App from "../app.ts"
import { stall, text } from "../server.ts"

const FILE = "sim-tui/fixtures/host.fixture.tsx"
const BOOT: App.BootOptions = { file: FILE, plugins: ["cmd/prime"], width: 120, height: 30 }
const { seeded } = App.runner(FILE, 1)

App.bootTest(BOOT)

seeded("the frame at rest", ({ seed }) =>
  App.seed(BOOT, { key: "host", seed, model: () => [text("Done."), stall] }, (tui) =>
    Effect.gen(function* () {
      yield* tui.settle
      yield* Console.log(tui.text().map((line) => `host-frame| ${line}`).join("\n"))
    }),
  ),
)

App.closeTest()
