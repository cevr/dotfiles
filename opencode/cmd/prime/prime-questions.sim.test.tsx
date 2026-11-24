// @reads all
// @reads-reason native TUI plugin loader reads at sim-tui/app.ts: createAppFixture({
// The background-question tools in the transcript, on the simulated TUI
// (sim-tui/) with Prime loaded by path, each at its first SEEDS seeds: a
// session asks the owner (`ask_user_async`), asks its orchestrator
// (`ask_orchestrator`) and answers a subagent (`answer_subagent`), one model
// step each, so each call is a group of its own. The three read alike, side by
// side: one family, each line naming whom (mods/prime/group.ts
// BACKGROUND_QUESTIONS) and showing the first question or the answered ref.
import { Effect } from "effect"
import * as App from "../../sim-tui/app.ts"
import { called, type Model, text } from "../../sim-tui/server.ts"

const FILE = "cmd/prime/prime-questions.sim.test.tsx"
/** Seeds this file runs: a seed only plays one turn of four steps. */
const SEEDS = 4
const { seeded } = App.runner(FILE, SEEDS)
const BOOT: App.BootOptions = {
  file: FILE,
  plugins: ["cmd/prime"],
  width: 100,
  height: 30,
  // Each call its own row, as the frame reads them; the default (low) folds a turn's calls into one.
  config: { session: { verbosity: "medium" } },
}

App.bootTest(BOOT)

const ASK = "Settle the port before you start."
const QUESTION = { question: "Which port should the dev server use?", options: [{ label: "8080" }, { label: "3000" }], assume: "8080" }
const RECEIPT = "Asked in the background; nobody has answered yet:\n- q1: Which port should the dev server use? · assuming 8080"

const model: Model = ({ step }) =>
  [
    [called({ id: "call_owner", tool: "ask_user_async", input: { questions: [QUESTION] }, output: RECEIPT })],
    [called({ id: "call_parent", tool: "ask_orchestrator", input: { questions: [QUESTION] }, output: RECEIPT })],
    [called({ id: "call_answer", tool: "answer_subagent", input: { answers: [{ id: "ses_child:q1", text: "3000" }] }, output: "Answered ses_child:q1." })],
    [text("Asked and answered.")],
  ][step] ?? []

/** The transcript's lines from the prompt to the model's last words, the blank ones dropped. */
const transcript = (frame: ReadonlyArray<string>): ReadonlyArray<string> => {
  const start = frame.findIndex((line) => line.includes(ASK))
  const end = frame.findIndex((line) => line.includes("Asked and answered."))
  return frame
    .slice(start, end + 1)
    .values()
    .filter((line) => line.trim() !== "")
    .toArray()
}

const play = (seed: number) =>
  App.seed(BOOT, { key: "prime-questions", seed, model, title: () => "questions" }, (tui) =>
    Effect.gen(function* () {
      yield* tui.type(ASK)
      yield* tui.press({ name: "enter" })
      yield* tui.until("answered", (frame) => frame.join("\n").includes("Asked and answered."))
      yield* tui.advance(500)
      return transcript(tui.text())
    }),
  )

seeded("the owner's question, the orchestrator's and a subagent's answer read alike, each naming whom", ({ seed, expect }) =>
  Effect.gen(function* () {
    expect(yield* play(seed)).toEqual([
      ` ┃ ${ASK}`,
      "  ● Asked the owner Which port should the dev server use?",
      "  ● Asked the orchestrator Which port should the dev server use?",
      "  ● Answered a subagent ses_child:q1: 3000",
      "  Asked and answered.",
    ])
  }),
)

App.closeTest()
