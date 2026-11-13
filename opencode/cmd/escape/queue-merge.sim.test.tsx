// tests/queue-merge.test.ts's names on the simulated TUI (sim-tui/), each at
// its first SEEDS seeds: the fork's real TUI in this process with Prime and
// the escape plugin loaded by path, in front of the server double, on a
// virtual clock. Waiting prompts act as one in the TUI: Up or Escape on the
// empty composer takes the queued prompts back as lines of one draft, and
// with nothing queued Up still walks the history. Each test plays its own
// case of scenarios/queue-merge.ts, step for step: the model holds its answer
// to the first prompt until the case releases it.
//
// The `deliver` case (three queued prompts reach the model as one message) is
// the escape server plugin's `experimental.queue.deliver` hook, which no
// server double runs: it stays real (tests/queue-merge.test.ts), and
// cmd/escape/server.test.ts holds the hook's answer.
import { Effect } from "effect"
import * as App from "../../sim-tui/app.ts"
import * as Golden from "../../sim-tui/golden.ts"
import { type Model, stall, text } from "../../sim-tui/server.ts"

const FILE = "cmd/escape/queue-merge.sim.test.tsx"
/** Seeds this file runs, per case: sim-tui's measured headroom rule (a file keeps half its 5 s of CPU). */
const SEEDS = 2
const { seeded } = App.runner(FILE, SEEDS)
const BOOT: App.BootOptions = { file: FILE, plugins: ["cmd/prime", "cmd/escape"], width: 106, height: 40 }

App.bootTest(BOOT)

const ASK = "Rename the helper."
const QUEUED = ["Also update the docs.", "Then run the tests.", "Then tag it."]
const PARTIAL = "Working on it"
const FINISHED = " and done."
const DONE = "All three done."
type Case = "up" | "escape" | "history"

/** The composer's rows: the last run of rail rows above the dock's rule. */
const composer = (lines: ReadonlyArray<string> = []) => {
  const rule = lines.findLastIndex((line) => /^ ─{10,}\s*$/.test(line))
  const above = lines.slice(0, Math.max(0, rule))
  const last = above.findLastIndex((line) => line.startsWith(" ┃"))
  const first = above.slice(0, last + 1).findLastIndex((line) => !line.startsWith(" ┃"))
  return above.slice(first + 1, last + 1)
}
const rows = (prompts: ReadonlyArray<string>) => prompts.map((prompt) => ` ┃ ${prompt}`)
/** Whether the composer holds exactly `prompts`. */
const holds = (frame: ReadonlyArray<string>, prompts: ReadonlyArray<string>) => composer(frame).join("\n") === rows(prompts).join("\n")
/** Whether the composer is empty: its one rail row and nothing on it. */
const empty = (frame: ReadonlyArray<string>) => composer(frame).join("\n") === " ┃"
const settled = (frame: ReadonlyArray<string>) => !frame.join("\n").includes("Executing") && !frame.join("\n").includes("◌")
const has = (shown: string) => (frame: ReadonlyArray<string>) => frame.join("\n").includes(shown)

/** The case's frames (`before`, `after`) and the prompts of each model request after the first, as the real scenario saves them. */
const play = (seed: number, which: Case) => {
  const requests: Array<string> = []
  // The first turn holds its answer until released; a later turn answers at once.
  const model: Model = ({ text: prompt, step }) => {
    if (prompt === ASK) return [[text(PARTIAL), stall]][step] ?? []
    if (step === 0) requests.push(prompt)
    return [[text(DONE)]][step] ?? []
  }
  return App.seed(BOOT, { key: which, seed, model, title: () => "helper rename" }, (tui) =>
    Effect.gen(function* () {
      const frames: Record<"before" | "after", ReadonlyArray<string>> = { before: [], after: [] }
      const release = Effect.sync(() => tui.server.release(tui.sessionID, FINISHED))
      yield* tui.type(ASK)
      yield* tui.press({ name: "enter" })
      yield* tui.until("streaming", has(PARTIAL))
      if (which === "history") {
        yield* release
        yield* tui.until("idle", (frame) => has(FINISHED)(frame) && settled(frame) && empty(frame))
        frames.before = tui.text()
        yield* tui.press({ name: "up" })
        yield* tui.until("after", (frame) => holds(frame, [ASK]))
        frames.after = tui.text()
        return { frames, requests }
      }
      // To the queue: leader (ctrl+x) then Enter, one at a time, each seen in the queue before the next.
      for (const prompt of QUEUED) {
        yield* tui.type(prompt)
        yield* tui.press({ name: "x", ctrl: true })
        yield* tui.press({ name: "enter" })
        yield* tui.until("queued", (frame) => has(`◌ after the turn · ${prompt}`)(frame) && empty(frame))
      }
      frames.before = tui.text()
      yield* tui.press({ name: which })
      yield* tui.until("taken", (frame) => holds(frame, QUEUED) && !has("◌")(frame))
      // The first answer ends (Up leaves its turn running; Escape cut it): a prompt the key failed to take back would
      // reach the model in a request after it.
      yield* release
      yield* tui.until("after", (frame) => settled(frame) && (has(FINISHED)(frame) || has("■ Interrupted")(frame)))
      frames.after = tui.text()
      return { frames, requests }
    }),
  )
}

const golden = (which: Case, frames: Record<"before" | "after", ReadonlyArray<string>>) =>
  Effect.forEach(["before", "after"] as const, (name) => Effect.map(Golden.check("queue-merge", `${which}-${name}`, frames[name]), (lines) => lines.map((line) => `${name} ${line}`))).pipe(
    Effect.map((each) => each.flat()),
  )

seeded("Up on the empty composer takes the three queued prompts back as three lines; the queue empties and nothing is sent", ({ seed, expect }) =>
  Effect.gen(function* () {
    const shown = yield* play(seed, "up")
    expect(yield* golden("up", shown.frames)).toEqual([])
    for (const prompt of QUEUED) expect(shown.frames.before.join("\n")).toContain(`◌ after the turn · ${prompt}`)
    expect(composer(shown.frames.before)).toEqual([" ┃"])
    expect(composer(shown.frames.after)).toEqual(rows(QUEUED))
    expect(shown.frames.after.join("\n")).not.toContain("◌")
    // The turn they waited behind ran on and ended; no request carried a queued prompt.
    expect(shown.requests).toEqual([])
  }),
)

seeded("Escape takes the three back the same way and stops the turn they waited behind", ({ seed, expect }) =>
  Effect.gen(function* () {
    const shown = yield* play(seed, "escape")
    expect(yield* golden("escape", shown.frames)).toEqual([])
    expect(composer(shown.frames.after)).toEqual(rows(QUEUED))
    expect(shown.frames.after.join("\n")).not.toContain("◌")
    expect(shown.frames.after.join("\n")).toContain("■ Interrupted")
    expect(shown.requests).toEqual([])
  }),
)

seeded("with nothing queued, Up on the empty composer still walks the history", ({ seed, expect }) =>
  Effect.gen(function* () {
    const shown = yield* play(seed, "history")
    expect(yield* golden("history", shown.frames)).toEqual([])
    expect(composer(shown.frames.before)).toEqual([" ┃"])
    expect(composer(shown.frames.after)).toEqual(rows([ASK]))
  }),
)

App.closeTest()
