// scenarios/prime-emphasis.ts on the simulated TUI (sim-tui/), each at its
// first SEEDS seeds: the fork's real TUI in this process with Prime loaded by
// path, in front of the server double, on a virtual clock. One ask, answered
// by a streamed reply holding each `[[Word]]` chip, a table cell and an "In
// the queue" section: the finished frame is the scenario's (the golden),
// each chip draws in its tone's colours, no frame while it streams shows a
// closed pill as typed or loses a row, and the stored reply is the text the
// model sent, untouched.
import { Effect, Option } from "effect"
import * as App from "../../sim-tui/app.ts"
import * as Golden from "../../sim-tui/golden.ts"
import { type Model, text } from "../../sim-tui/server.ts"

const FILE = "cmd/prime/prime-emphasis.sim.test.tsx"
/**
 * Seeds this file runs, by sim-tui's measured headroom rule (a file keeps half its 5 s of CPU): one
 * streamed reply of 1,100 characters a seed, recorded frame by frame, takes about 400 ms, so 4.
 */
const SEEDS = 4
const { seeded } = App.runner(FILE, SEEDS)
const BOOT: App.BootOptions = { file: FILE, plugins: ["cmd/prime"], width: 100, height: 40 }

App.bootTest(BOOT)

const ASK = "How did the disk cleanup go?"
/** scenarios/prime-emphasis.ts's reply, word for word. */
const REPLY = [
  "Disk is at 61% after the cleanup [[Measured]], down from 89%.",
  "",
  "- Build caches deleted in 104 workspaces [[Done 104/104]].",
  "- The deep accept run was not started [[Skipped]]: the host was loaded.",
  "- The upload check broke [[Failed: 3 tests]] on the token step.",
  "- The bucket move waits on the owner's login [[Blocked]].",
  "- The leak is the stale lock [[Inferred]] from the log tail.",
  "- The workbox may need a reboot [[Guess]].",
  "- The gate ran green [[Passed]].",
  "- Deleting the old bucket [[Irreversible]] loses the 2024 logs.",
  "- Moving it to cold storage [[Costs money]] about $4 a month.",
  "",
  "| unit | state |",
  "|---|---|",
  "| emphasis-draw | [[Done]] |",
  "| emphasis-rules | [[Blocked]] |",
  "",
  "In the queue:",
  "",
  "- **Running (mine):** the 95% disk watch.",
  "- **Waiting on you:** the bucket login.",
  "- **Dated (mine):** the cache review on 2026-11-20.",
  "- **Next:** emphasis-rules, after this lands.",
].join("\n")
const PILLS = Array.from(REPLY.matchAll(/\[\[([^\]]+)\]\]/g), (match) => match[1] ?? "")

const model: Model = ({ step }) => [[text(REPLY)]][step] ?? []

interface Played {
  readonly text: ReadonlyArray<string>
  readonly frame: App.Frame
  readonly streamed: ReadonlyArray<ReadonlyArray<string>>
  readonly stored: ReadonlyArray<string>
}

// The last label drawn, `**` concealed or not (opentui 0.9 conceals without tree-sitter, older drew it as typed here).
const done = (shown: ReadonlyArray<string>) => shown.join("\n").replaceAll("**", "").includes("Next: emphasis-rules") && !shown.join("\n").includes("Executing")

/** The scenario at `seed`, played once a seed (the tests read the same run). */
const played = new Map<number, Played>()
const scenario = (seed: number) =>
  Option.match(Option.fromUndefinedOr(played.get(seed)), {
    onSome: Effect.succeed,
    onNone: () => play(seed).pipe(Effect.tap((run) => Effect.sync(() => played.set(seed, run)))),
  })
const play = (seed: number) =>
  App.seed(BOOT, { key: "prime-emphasis", seed, model, title: () => "disk cleanup" }, (tui) =>
    Effect.gen(function* () {
      yield* tui.type(ASK)
      const [, streamed] = yield* tui.record(tui.press({ name: "enter" }).pipe(Effect.andThen(tui.until("emphasis", done))))
      yield* tui.advance(500)
      const stored = tui.server
        .messages(tui.sessionID)
        .flatMap((message) => {
          if (message.type !== "assistant") return []
          return message.content.flatMap((part) => {
            if (part.type !== "text") return []
            return [part.text]
          })
        })
      return { text: tui.text(), frame: tui.frame(), streamed, stored }
    }),
  )

/**
 * The simulated TUI's tree-sitter is OpenTUI's mock, which highlights nothing, so a block's bold
 * markers stay on screen where the real run's are hidden; dropped here, the rows are the real run's.
 */
const concealed = (lines: ReadonlyArray<string>) => lines.map((line) => line.replaceAll("**", ""))

/** The first span on screen whose text is `text`, with its colours and boldness. */
const spanOf = (frame: App.Frame, text: string) =>
  Option.fromUndefinedOr(frame.lines.flatMap((line) => line.spans).find((span) => span.text === text))

/** A closed pill as typed, or as tree-sitter draws it unhooked (`[Done]`, not a pill still open, `[[Done]`). */
const typed = (frame: ReadonlyArray<string>) => {
  const shown = frame.join("\n")
  return PILLS.filter((pill) => shown.includes(`[[${pill}]]`) || shown.split(`[${pill}]`).slice(0, -1).some((before, index, all) => !before.endsWith("[") && !(all[index + 1] ?? "").startsWith("]")))
}

/** The rows from the ask to the row under the reply (its end time, or the composer's rail); none before the reply draws. */
const replyRows = (frame: ReadonlyArray<string>) => {
  const ask = frame.findIndex((line) => line.includes(ASK))
  const end = frame.findIndex((line, row) => row > ask && (/ (ET|UTC)$/.test(line) || line.trim() === "┃"))
  return Option.some(end - ask).pipe(Option.filter(() => frame.some((line) => line.includes("│ unit"))), Option.toArray)
}

seeded("the finished reply is the scenario's frame: each chip as wide as its source, the queue's labels with their diamonds", ({ seed, expect }) =>
  Effect.gen(function* () {
    const run = yield* scenario(seed)
    expect(yield* Golden.check("prime-emphasis", "emphasis", concealed(run.text))).toEqual([])
  }),
)

seeded("each chip draws in its tone: a soft one its tone on a tinted ground, a solid one bold on its tone", ({ seed, expect }) =>
  Effect.gen(function* () {
    const run = yield* scenario(seed)
    const look = (text: string) => Option.map(spanOf(run.frame, text), (span) => ({ fg: span.fg, bg: span.bg, bold: (span.attributes & 1) === 1 }))
    const done = look(" ✓ Done 104/104 ")
    const measurementChip = look(" ● Measured ")
    const failed = look(" ✗ Failed: 3 tests ")
    const irreversible = look(" ! Irreversible ")
    for (const chip of [done, measurementChip, failed, irreversible]) expect(Option.isSome(chip)).toBe(true)
    // Done and Measured share the success tone: the same colours.
    expect(done).toEqual(measurementChip)
    expect(Option.map(failed, (span) => span.bold)).toEqual(Option.some(false))
    // A solid chip is drawn on its tone, which a soft chip of the same tone writes in.
    expect(Option.map(irreversible, (span) => span.bold)).toEqual(Option.some(true))
    expect(Option.map(irreversible, (span) => span.bg)).toEqual(Option.map(failed, (span) => span.fg))
    // The ground is opaque, never the terminal's own.
    expect(Option.map(failed, (span) => /, 1(\.0+)?\)$/.test(span.bg))).toEqual(Option.some(true))
  }),
)

seeded("while it streams, no frame shows a closed pill as typed, and the reply never loses a row", ({ seed, expect }) =>
  Effect.gen(function* () {
    const run = yield* scenario(seed)
    // Streamed, not drawn at once: opentui 0.9 holds an undecided last line, so a seed can draw it in three frames.
    expect(run.streamed.length).toBeGreaterThan(2)
    expect(run.streamed.flatMap(typed)).toEqual([])
    const rows = run.streamed.flatMap(replyRows)
    expect(rows.length).toBeGreaterThan(0)
    const shrank = rows.slice(1).flatMap((count, index) => {
      const before = rows[index] ?? 0
      if (count >= before) return []
      return [`${index + 1}: ${before} → ${count}`]
    })
    expect(shrank).toEqual([])
  }),
)

seeded("the stored reply is the text the model sent: the chips are drawn, never written", ({ seed, expect }) =>
  Effect.gen(function* () {
    const run = yield* scenario(seed)
    expect(run.stored).toEqual([REPLY])
  }),
)

App.closeTest()
