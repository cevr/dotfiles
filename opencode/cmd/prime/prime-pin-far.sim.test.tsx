// The pinned ask for a prompt outside the loaded transcript, on the simulated TUI (sim-tui/) with Prime loaded and
// the double paging session.messages as the real server does. A session played before the TUI opened it: two short
// turns, then a third of sixty steps. The TUI opens it on its newest twenty messages, all steps of the third turn, so
// its prompt is not loaded. Scrolled up into those steps, the pin still names it: Prime reads the session's prompts
// apart from the transcript (mods/prime/opencode/asks.ts). A click on the pin reads the transcript back to that
// prompt and shows it at the top (the fork's overlay reveal); a little further up, the pin is the turn before's
// prompt. The prompts are read once, one page, not once a scroll frame.
import { Data, Effect, Exit, Option } from "effect"
import * as App from "../../sim-tui/app.ts"
import type { Model, Took } from "../../sim-tui/server.ts"

const FILE = "cmd/prime/prime-pin-far.sim.test.tsx"
/** Seeds this file runs: a seed scrolls a sixty-step turn and reads a page back, about a second of CPU, so 2. */
const SEEDS = 2
const { seeded } = App.runner(FILE, SEEDS)
const BOOT: App.BootOptions = { file: FILE, plugins: ["cmd/prime"], width: 100, height: 30 }

App.bootTest(BOOT)

// The transcript's first row, under the one-row top bar.
const FIRST = 1
const ASK_ONE = "Start the survey."
const ASK_TWO = "Check the second shelf."
const ASK_THREE = "Now walk every aisle and count what is on each shelf, one step per aisle."
const step = (turn: string, index: number) => `${turn} step ${String(index + 1).padStart(2, "0")}`
const steps = (turn: string, count: number) => Array.from({ length: count }, (_, index) => step(turn, index))

/** No prompt is sent in this scenario. */
const model: Model = () => []

const NAMES = ["far-bottom", "far-pinned", "far-revealed", "far-crossed"] as const
type Name = (typeof NAMES)[number]
interface Played {
  readonly frames: Record<Name, ReadonlyArray<string>>
  /** The session.messages reads of `type=user` the TUI made. */
  readonly promptReads: number
  /** Those it had made when the session was open at the bottom, before any scroll. */
  readonly promptReadsAtBottom: number
  /** Whether the click on the pin read the transcript back to the unloaded prompt (the fork's overlay reveal). */
  readonly revealed: boolean
  /** Every session.messages read of the far session, in order: `newest` first, then `cursor`. */
  readonly pages: ReadonlyArray<string>
}

/** The session.messages reads of `sessionID` among the requests the double took. */
const messageReads = (requests: ReadonlyArray<Took>, sessionID: string) =>
  requests.filter((request) => request.method === "GET" && request.path === `/api/session/${sessionID}/message`)
/** A read of the session's prompts (`type=user`), the pin's side channel. */
const prompts = (request: Took) => new URLSearchParams(request.query).get("type") === "user"
const promptReadsOf = (requests: ReadonlyArray<Took>, sessionID: string) => messageReads(requests, sessionID).filter(prompts).length

const played = new Map<number, Played>()
const scenario = (seed: number) =>
  Option.match(Option.fromUndefinedOr(played.get(seed)), {
    onSome: Effect.succeed,
    onNone: () => play(seed).pipe(Effect.tap((run) => Effect.sync(() => played.set(seed, run)))),
  })

/** The click on the pin found no reveal that reads back: the fork lacks the overlay's reveal change. */
class NoReveal extends Data.TaggedError("NoReveal")<{ readonly message: string }> {}
/**
 * The scenario, for the tests after the click: they fail naming the cause when the click did not read the
 * transcript back, which is the fork's `session.transcript.overlay` reveal still `jumpToMessage` (before f694870eb5,
 * "fix(tui): the transcript overlay's reveal reads back to a message older than the loaded pages").
 */
const revealedScenario = (seed: number) =>
  scenario(seed).pipe(
    Effect.filterOrFail(
      (run) => run.revealed,
      () =>
        new NoReveal({
          message:
            "the click on the pinned prompt did not read the transcript back to it within 10 s: the fork's overlay reveal does not load older pages (it needs f694870eb5, the reveal as jumpToTurn; check OPENCODE_DEV's head)",
        }),
    ),
  )

const play = (seed: number) =>
  App.seed(BOOT, { key: "prime-pin-far", seed, model, pagedMessages: true }, (tui) =>
    Effect.gen(function* () {
      const frames: Record<Name, ReadonlyArray<string>> = { "far-bottom": [], "far-pinned": [], "far-revealed": [], "far-crossed": [] }
      const save = (name: Name) => Effect.sync(() => (frames[name] = tui.text()))
      const reveal = { done: false }
      const far = tui.server.session({ title: "The survey" })
      tui.server.history(far, [
        { ask: ASK_ONE, steps: steps("one", 3) },
        { ask: ASK_TWO, steps: steps("two", 3) },
        { ask: ASK_THREE, steps: steps("three", 60) },
      ])
      yield* tui.navigate(far)
      yield* tui.until("far-bottom", (shown) => shown.join("\n").includes("three step 60"))
      yield* tui.advance(500)
      yield* save("far-bottom")
      const promptReadsAtBottom = promptReadsOf(tui.server.requests(), far)
      // One wheel step up over the transcript at a time, until the frame is ready.
      const scrollUntil = (name: string, ready: (shown: ReadonlyArray<string>) => boolean) =>
        Effect.gen(function* () {
          for (let wheel = 0; wheel < 80; wheel++) {
            yield* tui.advance(150)
            if (ready(tui.text())) return
            yield* tui.mouse({ action: "scroll", x: 40, y: 12, direction: "up" })
          }
          yield* tui.until(name, ready)
        })
      // Into the third turn's loaded steps, its prompt far above them.
      yield* scrollUntil("far-pinned", (shown) => /three step 4[2-8]/.test(shown[FIRST + 1] ?? ""))
      yield* tui.advance(300)
      yield* save("far-pinned")
      // A click on the pin: the transcript reads back to the third prompt and puts it at the top.
      yield* tui.mouse({ action: "move", x: 10, y: FIRST })
      yield* tui.mouse({ action: "down", x: 10, y: FIRST })
      yield* tui.mouse({ action: "up", x: 10, y: FIRST })
      // A fork whose reveal cannot read back leaves the view where it was: the frames after it stay empty and only
      // the tests that read them fail, not the ones before.
      const revealed = yield* Effect.exit(tui.until("far-revealed", (shown) => shown.join("\n").includes("three step 01"), 10_000))
      reveal.done = Exit.isSuccess(revealed)
      if (reveal.done) {
        yield* tui.advance(500)
        yield* save("far-revealed")
        // A little further up, into the second turn's steps: its prompt is the pin.
        yield* scrollUntil("far-crossed", (shown) => /two step 0\d/.test(shown[FIRST + 1] ?? ""))
        yield* tui.advance(300)
        yield* save("far-crossed")
      }
      const reads = messageReads(tui.server.requests(), far)
      const run: Played = {
        frames,
        promptReadsAtBottom,
        revealed: reveal.done,
        promptReads: promptReadsOf(tui.server.requests(), far),
        pages: reads.filter((request) => !prompts(request)).map((request) => ["newest", "cursor"][Number(new URLSearchParams(request.query).has("cursor"))] ?? ""),
      }
      return run
    }),
  )

seeded("opened on its newest page, the session holds none of the third turn's prompt; at the bottom nothing is pinned", ({ seed, expect }) =>
  Effect.gen(function* () {
    const run = yield* scenario(seed)
    expect(run.pages[0]).toBe("newest")
    expect(run.frames["far-bottom"].join("\n")).not.toContain("┃ Now walk")
  }),
)

seeded("scrolled into the third turn's loaded steps, the pin is its prompt, which the transcript has not loaded", ({ seed, expect }) =>
  Effect.gen(function* () {
    const shown = (yield* scenario(seed)).frames["far-pinned"]
    expect(shown[FIRST]).toBe(` ┃ ${ASK_THREE}`)
    expect(shown[FIRST + 1]).toMatch(/three step 4[2-8]/)
    expect(shown.filter((line) => line.includes(ASK_THREE))).toHaveLength(1)
  }),
)

seeded("a click on the pin reads the transcript back to the third prompt and shows it at the top", ({ seed, expect }) =>
  Effect.gen(function* () {
    const run = yield* revealedScenario(seed)
    const shown = run.frames["far-revealed"]
    expect(shown[FIRST]).toBe(` ┃ ${ASK_THREE}`)
    expect(shown.slice(FIRST + 1).find((line) => line.trim() !== "")?.trim()).toBe("three step 01")
    expect(run.pages.filter((page) => page === "cursor").length).toBeGreaterThan(0)
  }),
)

seeded("scrolled up across into the second turn, the pin changes to its prompt", ({ seed, expect }) =>
  Effect.gen(function* () {
    const shown = (yield* revealedScenario(seed)).frames["far-crossed"]
    expect(shown[FIRST]).toBe(` ┃ ${ASK_TWO}`)
    expect(shown[FIRST + 1]).toMatch(/two step 0\d/)
  }),
)

seeded("the prompts are read once, one page, for the whole scenario: never once a scroll frame", ({ seed, expect }) =>
  Effect.gen(function* () {
    expect((yield* scenario(seed)).promptReads).toBe(1)
  }),
)

seeded("nothing is read for the pin while the session opens and sits at the bottom: the first read waits for a scroll up", ({ seed, expect }) =>
  Effect.gen(function* () {
    expect((yield* scenario(seed)).promptReadsAtBottom).toBe(0)
  }),
)

App.closeTest()
