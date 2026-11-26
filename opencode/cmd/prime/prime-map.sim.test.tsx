// @reads all
// @reads-reason native TUI plugin loader reads at sim-tui/app.ts: createAppFixture({
// The transcript map (ctrl+x g) on the simulated TUI with Prime loaded: the
// transcript with every turn folded to one line in Prime's look, in the
// transcript's place. Three asks, each a thought and a shell call, then a
// two-sentence answer with a 30-line list; scrolled up into answer 2, the map
// opens whole (it fits) with that turn selected, a prompt
// behind the `┃` rail in bold, a run as its first sentence, its work and the
// time it ended on the right; Esc shows the transcript as it was, and Enter
// unfolds it at the selected turn, its start on its collapsed row's line.
import { Effect, Option } from "effect"
import * as App from "../../sim-tui/app.ts"
import { type Model, ranShell, reasoning, text } from "../../sim-tui/server.ts"

const FILE = "cmd/prime/prime-map.sim.test.tsx"
/** Seeds this file runs: three asks streamed and the map opened twice take about as long as prime-pin's seed, so 4. */
const SEEDS = 4
const { seeded } = App.runner(FILE, SEEDS)
const BOOT: App.BootOptions = { file: FILE, plugins: ["cmd/prime"], width: 100, height: 30 }

App.bootTest(BOOT)

// The transcript's first row, under the one-row top bar.
const FIRST = 1
const NAMES = ["one", "two", "three"] as const
const ask = (index: number) => `Ask number ${NAMES[index]}`
const list = (name: string) => Array.from({ length: 30 }, (_, item) => `- ${name} item ${String(item + 1).padStart(2, "0")}`).join("\n")

/** Each ask: a thought and a shell call, then its answer: two sentences and a list. */
const model: Model = ({ text: prompt, step }) => {
  const name = NAMES.find((each) => prompt.endsWith(each)) ?? "one"
  const steps = [
    [reasoning(`Weighing ask ${name}`), ranShell({ id: `call_${name}`, command: `echo ${name}`, output: "ok" })],
    [text(`Answer ${name} is ready. Here is the list.\n\n${list(name)}`)],
  ]
  return steps[step] ?? []
}

type Frames = Record<"expanded" | "collapsed" | "restored" | "unfolded", ReadonlyArray<string>> & {
  readonly look: App.Frame
  /** The line the turn Enter unfolded had in the map, and its name. */
  readonly picked: { readonly line: number; readonly name: string }
}

const played = new Map<number, Frames>()
const scenario = (seed: number) =>
  Option.match(Option.fromUndefinedOr(played.get(seed)), {
    onSome: Effect.succeed,
    onNone: () => play(seed).pipe(Effect.tap((frames) => Effect.sync(() => played.set(seed, frames)))),
  })

const isMap = (shown: ReadonlyArray<string>) => shown.join("\n").includes("· + 1 thought, 1 tool")
const play = (seed: number) =>
  App.seed(BOOT, { key: "prime-map", seed, model, title: () => "three asks" }, (tui) =>
    Effect.gen(function* () {
      const submit = (index: number) => tui.type(ask(index)).pipe(Effect.andThen(tui.press({ name: "enter" })))
      const done = (name: string) => (shown: ReadonlyArray<string>) => shown.join("\n").includes(`${name} item 30`) && !shown.join("\n").includes("Executing")
      for (const [index, name] of NAMES.entries()) {
        yield* submit(index)
        yield* tui.until(`answer ${name}`, done(name))
      }
      yield* tui.advance(500)
      // Up into answer two's list.
      for (let step = 0; step < 60; step++) {
        if (/two item (0[5-9]|1\d)/.test(tui.text()[FIRST + 1] ?? "")) break
        yield* tui.mouse({ action: "scroll", x: 40, y: 12, direction: "up" })
        yield* tui.advance(150)
      }
      yield* tui.advance(300)
      const expanded = tui.text()
      const open = Effect.gen(function* () {
        yield* tui.press({ name: "x", ctrl: true })
        yield* tui.press({ name: "g" })
        yield* tui.until("the map", isMap)
        yield* tui.advance(300)
      })
      yield* open
      const collapsed = tui.text()
      const look = tui.frame()
      yield* tui.press({ name: "escape" })
      yield* tui.until("the transcript again", (shown) => !isMap(shown))
      yield* tui.advance(300)
      const restored = tui.text()
      // Again, then one turn down (the opened run's next turn is the prompt after its blank line) and Enter.
      yield* open
      yield* tui.press({ name: "j" })
      yield* tui.advance(100)
      const line = tui.text().findIndex((row, index) => index > FIRST && row.includes(ask(2)))
      yield* tui.press({ name: "enter" })
      yield* tui.until("unfolded", (shown) => !isMap(shown))
      yield* tui.advance(500)
      return { expanded, collapsed, restored, unfolded: tui.text(), look, picked: { line, name: "three" } } satisfies Frames
    }),
  )

seeded("the map folds the transcript in place: a session that fits shows whole, the turn at the top selected, and Esc shows it as it was", ({ seed, expect }) =>
  Effect.gen(function* () {
    const frames = yield* scenario(seed)
    // The transcript's top shows answer two's list (under the pinned ask).
    expect(frames.expanded[FIRST + 1]).toMatch(/two item/)
    // Folded, the three asks fit with room to spare: the map shows them from the session's start rather than leave
    // blank lines below the last turn, and answer two's run, the turn at the transcript's top, is the one selected.
    expect(frames.collapsed[FIRST]).toMatch(/^ *\w{3} \w{3} \d{2} *$/)
    for (const index of [0, 1, 2]) expect(frames.collapsed.join("\n")).toContain(ask(index))
    const background = (text: string) =>
      frames.look.lines.flatMap((line) => line.spans).find((span) => span.text.includes(text))?.bg
    expect(background("Answer two is ready.")).not.toEqual(background("Answer three is ready."))
    expect(background("Answer one is ready.")).toEqual(background("Answer three is ready."))
    expect(frames.restored).toEqual(frames.expanded)
  }),
)

seeded("each turn is one line in the transcript's own look: the prompt's rail, a run's sentence, work and time", ({ seed, expect }) =>
  Effect.gen(function* () {
    const frames = yield* scenario(seed)
    const shown = frames.collapsed
    // No chrome of its own.
    expect(shown.join("\n")).not.toMatch(/Transcript map|\d+ turns|esc back/)
    const prompt = shown.findIndex((line) => line.includes(ask(2)))
    // The prompt as the transcript draws it: the rail at the inset, a space, the text.
    expect(shown[prompt]).toMatch(new RegExp(`^ ┃ ${ask(2)} *$`))
    expect(shown[prompt - 1]?.trim()).toBe("")
    // Its run right under it: the first sentence at the prose column, its work, the time it ended at the right.
    expect(shown[prompt + 1]).toMatch(/^ {2}Answer three is ready\. · \+ 1 thought, 1 tool +\d{1,2}:\d{2} [AP]M [A-Z][A-Za-z+\-:\d]*(?: · \d{2}:\d{2} [A-Z][A-Za-z+\-:\d]*)? *$/)
    const spans = (y: number) => (frames.look.lines[y]?.spans ?? []).filter((span) => span.text.trim() !== "")
    const bold = (y: number, text: string) => spans(y).find((span) => span.text.includes(text))?.attributes ?? 0
    expect(bold(prompt, ask(2)) & 1).toBe(1)
    const colour = (y: number, text: string) => spans(y).find((span) => span.text.includes(text))?.fg
    expect(colour(prompt + 1, "+ 1 thought")).not.toEqual(colour(prompt + 1, "Answer three"))
  }),
)

seeded("Enter unfolds the transcript at the selected turn, its start on the line its collapsed row was on", ({ seed, expect }) =>
  Effect.gen(function* () {
    const frames = yield* scenario(seed)
    expect(frames.picked.line).toBeGreaterThan(FIRST)
    expect(frames.unfolded[frames.picked.line]).toContain(`┃ ${ask(2)}`)
  }),
)

App.closeTest()
