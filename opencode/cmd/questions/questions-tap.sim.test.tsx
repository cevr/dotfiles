// The tray is tappable, on the simulated TUI (sim-tui/), each test at its first
// SEEDS seeds: the fork's real TUI in this process with Prime and the questions
// plugin loaded by path, in front of the server double, on a virtual clock. The
// questions server plugin is a stand-in on the double (`rpc`): it answers
// `open` with one question of the session on screen. A click on the tray line
// above the composer opens the host's question form for it, as shift+← on an
// empty composer and /answer do; a click elsewhere opens none.
import { Effect, Option, Schema } from "effect"
import { type Open, QUESTIONS } from "@dotfiles/opencode-questions/question"
import { COMMAND, GLYPH } from "@dotfiles/opencode-questions/tray"
import * as App from "../../sim-tui/app.ts"
import { type Model, type Rpc, text } from "../../sim-tui/server.ts"

const FILE = "cmd/questions/questions-tap.sim.test.tsx"
/** Seeds this file runs: a seed only boots a session and clicks twice, so 4 keep most of the file's 5 s free. */
const SEEDS = 4
const { seeded } = App.runner(FILE, SEEDS)
const BOOT: App.BootOptions = { file: FILE, plugins: ["cmd/prime", "cmd/questions"], width: 100, height: 30 }

App.bootTest(BOOT)

const QUESTION = "Which port should the dev server use?"
const ASSUME = "8080"
const model: Model = () => [text("Done.")]

const Asked = Schema.Struct({ sessionIDs: Schema.NonEmptyArray(Schema.String) })
/** The questions RPC's stand-in: `open` answers one question of the first session it is asked for (the session on screen; its subagents follow). */
const questions: Rpc = (call) =>
  Schema.decodeUnknownOption(Asked)(call.input).pipe(
    Option.filter(() => call.rpcID === QUESTIONS.id && call.method === "open"),
    Option.map((input) => ({ questions: [{ id: "q1", sessionID: input.sessionIDs[0], question: QUESTION, assume: ASSUME, askedAt: 0 }] }) satisfies Open),
  )

/** The row the tray is on, and the column of its `/answer`. */
const trayAt = (shown: ReadonlyArray<string>) => {
  const y = shown.findIndex((line) => line.trimStart().startsWith(`${GLYPH} 1 open question`))
  return { y, x: (shown[y] ?? "").lastIndexOf(COMMAND) }
}
const click = (tui: App.Tui, x: number, y: number) =>
  Effect.gen(function* () {
    yield* tui.mouse({ action: "move", x, y })
    yield* tui.mouse({ action: "down", x, y })
    yield* tui.mouse({ action: "up", x, y })
  })
/** Where a seed clicks on the tray: its glyph at the start, or its `/answer`. */
const COLUMNS = { start: () => 4, answer: (tray: { readonly x: number }) => tray.x } as const
const formShown = (shown: ReadonlyArray<string>) => shown.some((line) => line.includes(QUESTION) && !line.trimStart().startsWith(GLYPH))

/** The seed's frames: the tray, then after a click at the composer, then after a click on the tray. */
const play = (seed: number, where: "start" | "answer") =>
  App.seed(BOOT, { key: `questions-tap-${where}`, seed, model, rpc: questions }, (tui) =>
    Effect.gen(function* () {
      yield* tui.until("the tray", (shown) => trayAt(shown).y >= 0)
      const tray = trayAt(tui.text())
      const before = tui.text()
      const spans = tui.frame().lines[tray.y]?.spans ?? []
      // A click on the composer, the row under the tray's, opens nothing.
      yield* click(tui, 10, tray.y + 2)
      yield* tui.advance(500)
      const elsewhere = tui.text()
      yield* click(tui, COLUMNS[where](tray), tray.y)
      yield* tui.advance(500)
      return { before, spans, elsewhere, after: tui.text(), opened: tui.server.requests().filter((request) => request.method === "POST" && request.path.endsWith("/form")) }
    }),
  )

seeded("a click on the tray's start opens the host's form for the session's question", ({ seed, expect }) =>
  Effect.gen(function* () {
    const seen = yield* play(seed, "start")
    expect(formShown(seen.before)).toBe(false)
    expect(formShown(seen.elsewhere)).toBe(false)
    expect(seen.opened).toHaveLength(1)
    expect(seen.opened[0]?.body).toContain(`"ask_user_async:q1"`)
    expect(formShown(seen.after)).toBe(true)
  }),
)

/** OpenTUI's underline attribute (TextAttributes.UNDERLINE). */
const UNDERLINE = 1 << 3

seeded("the tray says it is tappable: /answer, and only it, is underlined", ({ seed, expect }) =>
  Effect.gen(function* () {
    const seen = yield* play(seed, "start")
    const underlined = seen.spans.filter((span) => (span.attributes & UNDERLINE) !== 0).map((span) => span.text)
    expect(underlined.join("")).toBe(COMMAND)
  }),
)

seeded("a click on /answer opens it too, once", ({ seed, expect }) =>
  Effect.gen(function* () {
    const seen = yield* play(seed, "answer")
    expect(seen.opened).toHaveLength(1)
    expect(formShown(seen.after)).toBe(true)
  }),
)

App.closeTest()
