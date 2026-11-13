// tests/escape-subagent.test.ts's names on the simulated TUI (sim-tui/), each
// at its first SEEDS seeds: the fork's real TUI in this process with Prime and
// the escape plugin loaded by path, in front of the server double, on a
// virtual clock. Escape in a subagent's view closes its picker first, then
// goes back to the parent, never interrupting. scenarios/escape-subagent.ts
// step for step: the parent starts one background worker, whose answers stall
// 20 s after their first words (the double holds them; the test ends each
// stall 20 s of virtual time after it began, as the real model's pause does).
import { Effect, Option } from "effect"
import * as App from "../../sim-tui/app.ts"
import * as Golden from "../../sim-tui/golden.ts"
import { MODEL_REF, type Model, stall, subagent, text } from "../../sim-tui/server.ts"
import { composerRow } from "../../tests/composer.ts"

const FILE = "cmd/escape/escape-subagent.sim.test.tsx"
/** Seeds this file runs: sim-tui's measured headroom rule (a file keeps half its 5 s of CPU). */
const SEEDS = 4
const { seeded } = App.runner(FILE, SEEDS)
const BOOT: App.BootOptions = { file: FILE, plugins: ["cmd/prime", "cmd/escape"], width: 106, height: 40 }

App.bootTest(BOOT)

const ASK = "Fix the money parsing in a worker."
const STARTED = "The worker is on it."
const BRIEF = "Worker brief: fix money parsing."
const WORKING = "Reading the parser"
const DONE = " and done."
const STEER = "Check the cents rounding too."
const STEERED = "Cents rounding checked"
const NOW = "Stop and ship the fix now."
const SHIPPED = "Shipped the fix."
/** How long each stalled answer stalls after its first words: past every press made while it stalls. */
const STALL = 20_000
const NAMES = ["picker", "dismissed", "typed", "steered", "parent", "parent-steered", "back", "drafted", "sent", "answered"] as const
type Name = (typeof NAMES)[number]

/** The picker's header row: the host's composer panel, its Subagents tab first. */
const isPicker = (frame: ReadonlyArray<string>) => frame.some((line) => /^\s*┃\s+Subagents(\s|$)/.test(line))
/** The root's picker lists the worker as Prime's panel rows read (mods/prime/panel.ts): its tab counts it, its row ends `working  12s`. */
const listed = (frame: ReadonlyArray<string>) => /┃\s+Subagents 1\s/.test(frame.join("\n")) && /Fix money parsing .* working +\d+s/.test(frame.join("\n"))
const has = (shown: string) => (frame: ReadonlyArray<string>) => frame.join("\n").includes(shown)

interface Played {
  readonly frames: Record<Name, ReadonlyArray<string>>
  /** One per model request of the worker: `brief`, `steer` when it carries the steer, `now` when it carries the second message. */
  readonly requests: ReadonlyArray<string>
  readonly golden: ReadonlyArray<string>
}

/** The seed's virtual clock, once it booted, and when the worker's latest answer began to stall. */
interface Stalls {
  elapsed: () => number
  stalled: number
}

const play = (seed: number) => {
  const requests: Array<string> = []
  const served: Stalls = { elapsed: () => 0, stalled: 0 }
  /** How many user messages each session had at its last model request: a step goes on only for a tool's result or a new message. */
  const seen = new Map<string, number>()
  const model: Model = ({ sessionID, text: prompt, step, users: texts }) => {
    // The parent: the worker's call, then its words once the call answered.
    if (prompt === ASK)
      return [[subagent({ id: "call_worker", input: { agent: "general", description: "Fix money parsing", prompt: BRIEF, background: true }, title: "Fix money parsing", agent: "general", model: MODEL_REF })], [text(STARTED)]][step] ?? []
    if (texts.length === (seen.get(sessionID) ?? 0)) return []
    seen.set(sessionID, texts.length)
    const all = texts.join("\n")
    const kind = [["now", NOW], ["steer", STEER]].find(([, needle]) => all.includes(needle ?? ""))?.[0] ?? "brief"
    requests.push(kind)
    if (kind === "now") return [text(SHIPPED)]
    served.stalled = served.elapsed()
    return [text([WORKING, STEERED][Number(kind === "steer")] ?? WORKING), stall]
  }
  return App.seed(BOOT, { key: "escape-subagent", seed, model, title: () => "money parsing" }, (tui) =>
    Effect.gen(function* () {
      served.elapsed = tui.elapsed
      const frames = new Map<Name, ReadonlyArray<string>>()
      const save = (name: Name) => Effect.sync(() => frames.set(name, tui.text()))
      yield* tui.type(ASK)
      yield* tui.press({ name: "enter" })
      yield* tui.until("started", (frame) => has(STARTED)(frame) && has("1 subagent")(frame))
      yield* tui.press({ name: "down" })
      yield* tui.until("root-picker", listed)
      yield* tui.press({ name: "enter" })
      yield* tui.until("picker", (frame) => has(WORKING)(frame) && has("Subagents")(frame))
      yield* save("picker")
      yield* tui.press({ name: "escape" })
      yield* tui.advance(1_500)
      yield* save("dismissed")
      yield* tui.type(STEER)
      yield* tui.until("typed", has(STEER))
      yield* save("typed")
      yield* tui.press({ name: "enter" })
      yield* tui.advance(1_500)
      yield* save("steered")
      // Nothing open: back to the parent, whose view shows its own prompt.
      yield* tui.press({ name: "escape" })
      yield* tui.until("parent", has(ASK))
      yield* tui.advance(1_500)
      yield* save("parent")
      // The worker's stalled answer ends on its own and its turn takes the steer, the parent still on screen.
      yield* tui.advance(Math.max(0, served.stalled + STALL - tui.elapsed()))
      const worker = tui.server.children(tui.sessionID)[0] ?? ""
      tui.server.release(worker, DONE)
      yield* tui.until("parent-steered", () => requests.includes("steer"), 40_000)
      yield* tui.advance(500)
      yield* save("parent-steered")
      yield* tui.press({ name: "down" })
      yield* tui.until("back-picker", listed)
      yield* tui.press({ name: "enter" })
      yield* tui.until("back", (frame) => has(STEERED)(frame) && !has(ASK)(frame))
      if (isPicker(tui.text())) {
        yield* tui.press({ name: "escape" })
        yield* tui.until("back-dismissed", (frame) => !isPicker(frame))
      }
      yield* save("back")
      yield* tui.type(NOW)
      yield* tui.until("drafted", has(NOW))
      yield* save("drafted")
      yield* tui.press({ name: "enter", ctrl: true })
      // The real run saves this frame once the interrupt shows; its answer was there by then, as the golden reads.
      yield* tui.until("sent", (frame) => has("Interrupted")(frame) && has(SHIPPED)(frame))
      yield* save("sent")
      yield* tui.until("answered", has(SHIPPED))
      yield* save("answered")
      const shown = (name: Name) => frames.get(name) ?? []
      const all: Record<Name, ReadonlyArray<string>> = {
        picker: shown("picker"),
        dismissed: shown("dismissed"),
        typed: shown("typed"),
        steered: shown("steered"),
        parent: shown("parent"),
        "parent-steered": shown("parent-steered"),
        back: shown("back"),
        drafted: shown("drafted"),
        sent: shown("sent"),
        answered: shown("answered"),
      }
      const golden = yield* Effect.forEach(NAMES, (name) => Effect.map(Golden.check("escape-subagent", name, all[name]), (lines) => lines.map((line) => `${name} ${line}`)))
      return { frames: all, requests, golden: golden.flat() } satisfies Played
    }),
  )
}

/** The scenario at `seed`, played once a seed (the seven tests read the same run, as the real tests read one replay). */
const played = new Map<number, Played>()
const scenario = (seed: number) =>
  Option.match(Option.fromUndefinedOr(played.get(seed)), {
    onSome: Effect.succeed,
    onNone: () => play(seed).pipe(Effect.tap((run) => Effect.sync(() => played.set(seed, run)))),
  })

/** The composer's first row (tests/composer.ts; the dock's session row sits above it). */
const composer = (frame: ReadonlyArray<string>) => frame[composerRow(frame)] ?? ""
const joined = (frame: ReadonlyArray<string>) => frame.join("\n")

seeded("the subagent's view opens on its picker", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { frames, golden } = yield* scenario(seed)
    expect(golden).toEqual([])
    expect(isPicker(frames.picker)).toBe(true)
    expect(joined(frames.picker)).toContain("Reading the parser")
  }),
)

seeded("the first Escape puts the picker away, the subagent still running, and the prompt takes what is typed", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { frames } = yield* scenario(seed)
    expect(isPicker(frames.dismissed)).toBe(false)
    expect(joined(frames.dismissed)).toContain("Reading the parser")
    expect(joined(frames.dismissed)).not.toContain("Interrupted")
    expect(composer(frames.typed)).toContain("Check the cents rounding too.")
  }),
)

seeded("a message sent from the subagent's prompt waits for it, the subagent still running", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { frames } = yield* scenario(seed)
    expect(joined(frames.steered)).not.toContain("Interrupted")
    expect(composer(frames.steered)).not.toContain("Check the cents rounding too.")
  }),
)

seeded("the next Escape, nothing open, shows the parent's view, the subagent still running", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { frames } = yield* scenario(seed)
    expect(joined(frames.parent)).toContain(ASK)
    expect(joined(frames.parent)).toContain("The worker is on it.")
    // A subagent's view says ↑ goes back to its parent; the parent's does not.
    expect(joined(frames.parent)).not.toContain("back to parent")
    expect(isPicker(frames.parent)).toBe(false)
    // The dock counts the subagent and its row still works on its first answer.
    expect(joined(frames.parent)).toContain("1 subagent")
    expect(joined(frames.parent)).toMatch(/general gpt\s+Fix money parsing\s+Reading the parser/)
  }),
)

seeded("the message reaches the subagent once its turn ends, the parent still on screen", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { frames, requests } = yield* scenario(seed)
    expect(joined(frames["parent-steered"])).toContain(ASK)
    expect(joined(frames["parent-steered"])).not.toContain("back to parent")
    // The parent's dock row already shows the subagent answering the message.
    expect(joined(frames["parent-steered"])).toMatch(/general gpt\s+Fix money parsing\s+Cents rounding checked/)
    expect(requests.slice(0, 2)).toEqual(["brief", "steer"])
  }),
)

seeded("the subagent was never interrupted: its first answer ran to its end, then it took the message and answered it", ({ seed, expect }) =>
  Effect.gen(function* () {
    const back = joined((yield* scenario(seed)).frames.back)
    expect(back).toContain("Reading the parser and done.")
    expect(back.indexOf("Check the cents rounding too.")).toBeGreaterThan(back.indexOf("Reading the parser and done."))
    expect(back).toContain("Cents rounding checked")
    expect(back).not.toContain("Interrupted")
  }),
)

seeded("Ctrl+Enter in the subagent's view interrupts it and sends the draft at once", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { frames, requests } = yield* scenario(seed)
    expect(composer(frames.drafted)).toContain("Stop and ship the fix now.")
    expect(joined(frames.sent)).toContain("Interrupted")
    // The answer to the steer stalled: the interrupt cut it before its end.
    expect(joined(frames.answered)).not.toContain("Cents rounding checked and done.")
    expect(joined(frames.answered)).toContain("Shipped the fix.")
    // The messages went as the subagent's own agent: sending them did not switch the subagent to a primary agent.
    expect(joined(frames.answered)).not.toContain("Switched agent")
    expect(requests).toEqual(["brief", "steer", "now"])
  }),
)

App.closeTest()
