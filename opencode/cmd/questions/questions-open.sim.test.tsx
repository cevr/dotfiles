// @reads all
// @reads-reason native TUI plugin loader reads at sim-tui/app.ts: createAppFixture({
// Opening the questions form is idempotent and never stale, on the simulated
// TUI (sim-tui/), each test at its first SEEDS seeds: the fork's real TUI with
// Prime and the questions plugin, in front of the server double. The questions
// server plugin is a stand-in on the double (`rpc`) whose open questions the
// seed changes. The owner's report (2026-11-21): on a server under contention,
// clicking "Background questions" several times opened the form as many times,
// and after he answered it the same answered questions came back, once per
// extra click.
// - Clicks and shift+← pressed again before the first form shows open one form.
// - A click after the questions were answered elsewhere, before the tray read
//   them again, opens nothing: the form is built from the questions open now.
import { Effect, Option, Schema } from "effect"
import { type Open, QUESTIONS, type Question } from "@dotfiles/opencode-questions/question"
import { GLYPH } from "@dotfiles/opencode-questions/tray"
import * as App from "../../sim-tui/app.ts"
import { type Model, type Rpc, text } from "../../sim-tui/server.ts"

const FILE = "cmd/questions/questions-open.sim.test.tsx"
/** Seeds this file runs: a seed boots a session and clicks a few times. */
const SEEDS = 4
const { seeded } = App.runner(FILE, SEEDS)
const BOOT: App.BootOptions = { file: FILE, plugins: ["cmd/prime", "cmd/questions"], width: 100, height: 30 }

App.bootTest(BOOT)

const QUESTION = "Which port should the dev server use?"
const model: Model = () => [text("Done.")]

const Asked = Schema.Struct({ sessionIDs: Schema.NonEmptyArray(Schema.String) })
/** The questions RPC's stand-in: `open` answers what `open.now` holds for the session on screen. */
const standIn = () => {
  const open = { now: true }
  const rpc: Rpc = (call) =>
    Schema.decodeUnknownOption(Asked)(call.input).pipe(
      Option.filter(() => call.rpcID === QUESTIONS.id && call.method === "open"),
      Option.map((input) => {
        const questions: ReadonlyArray<Question> = [{ id: "q1", sessionID: input.sessionIDs[0], question: QUESTION, assume: "8080", askedAt: 0 }]
        return { questions: questions.filter(() => open.now), held: [] } satisfies Open
      }),
    )
  return { open, rpc }
}

const trayRow = (shown: ReadonlyArray<string>) => shown.findIndex((line) => line.trimStart().startsWith(`${GLYPH} 1 open question`))
const click = (tui: App.Tui, x: number, y: number) =>
  Effect.gen(function* () {
    yield* tui.mouse({ action: "move", x, y })
    yield* tui.mouse({ action: "down", x, y })
    yield* tui.mouse({ action: "up", x, y })
  })
const formsMade = (tui: App.Tui) => tui.server.requests().filter((request) => request.method === "POST" && request.path.endsWith("/form"))

seeded("three clicks on the tray before the form shows open one form", ({ seed, expect }) => {
  const { rpc } = standIn()
  return App.seed(BOOT, { key: "questions-open-clicks", seed, model, rpc }, (tui) =>
    Effect.gen(function* () {
      yield* tui.until("the tray", (shown) => trayRow(shown) >= 0)
      const y = trayRow(tui.text())
      // Three clicks in one breath, as on a server too slow to show the first form before the next click.
      yield* click(tui, 4, y)
      yield* click(tui, 4, y)
      yield* click(tui, 4, y)
      yield* tui.advance(1000)
      expect(formsMade(tui)).toHaveLength(1)
      // Once it shows, a click and shift+← only find it there.
      yield* click(tui, 4, y)
      yield* tui.advance(1000)
      expect(formsMade(tui)).toHaveLength(1)
      expect(tui.text().some((line) => line.includes(QUESTION))).toBe(true)
    }),
  ).pipe(Effect.asVoid)
})

seeded("a click after the questions were answered elsewhere, before the tray read them again, opens nothing", ({ seed, expect }) => {
  const { open, rpc } = standIn()
  return App.seed(BOOT, { key: "questions-open-stale", seed, model, rpc }, (tui) =>
    Effect.gen(function* () {
      yield* tui.until("the tray", (shown) => trayRow(shown) >= 0)
      const y = trayRow(tui.text())
      // Answered meanwhile (the digest page, another TUI): the server has no open question; the tray's last reading still shows one.
      open.now = false
      yield* click(tui, 4, y)
      yield* tui.advance(500)
      expect(formsMade(tui)).toHaveLength(0)
      expect(tui.text().some((line) => line.includes(QUESTION) && !line.trimStart().startsWith(GLYPH))).toBe(false)
    }),
  ).pipe(Effect.asVoid)
})

App.closeTest()
