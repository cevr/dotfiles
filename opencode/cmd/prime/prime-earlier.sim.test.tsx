// A short session at rest, on the simulated TUI (sim-tui/) with Prime loaded and the double paging session.messages
// as the real server does: every non-empty page carries a `next` cursor, the last one too. The whole session fits on
// its first page and on the screen, so nothing is left to read; once that read settles, the transcript's top is the
// session's start, never "Loading earlier messages…" (which a cursor on the last page kept spinning for good). It
// needs the fork's e2ac1c22ad (the read past a transcript that fits the screen).
import { Effect } from "effect"
import * as App from "../../sim-tui/app.ts"
import type { Model } from "../../sim-tui/server.ts"

const FILE = "cmd/prime/prime-earlier.sim.test.tsx"
/** Seeds this file runs: a seed opens one short session, well under a second of CPU. */
const SEEDS = 2
const { seeded } = App.runner(FILE, SEEDS)
const BOOT: App.BootOptions = { file: FILE, plugins: ["cmd/prime"], width: 100, height: 30 }

App.bootTest(BOOT)

const ASK = "Count the shelves."
/** No prompt is sent in this scenario. */
const model: Model = () => []

seeded("a short session at rest shows no loading row once its history read settles", ({ seed, expect }) =>
  App.seed(BOOT, { key: "prime-earlier", seed, model, pagedMessages: true }, (tui) =>
    Effect.gen(function* () {
      const short = tui.server.session({ title: "Short" })
      tui.server.history(short, [{ ask: ASK, steps: ["shelf one", "shelf two"] }])
      yield* tui.navigate(short)
      yield* tui.until("the short session", (shown) => shown.join("\n").includes("shelf two"))
      // Past the TUI's frames of the first read, the boundary's and the plugins' drawing.
      yield* tui.advance(3_000)
      const shown = tui.text().join("\n")
      expect(shown).toContain(ASK)
      expect(shown).not.toContain("Loading earlier messages")
      expect(shown).not.toContain("Earlier messages")
    }),
  ),
)

App.closeTest()
