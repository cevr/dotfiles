// `$<skill>` in the composer, with a skill both tiers hold. The project has
// `review` in `.claude/skills` (local); OpenCode's config directory, which
// opencode-drive points at the project's `.opencode` (OPENCODE_CONFIG_DIR),
// has another `review` and a `deploy` (global). The user types `$`: the popup
// lists all three with their tiers, the global review marked shadowed. They
// pick review and send; the model's request carries the local review's body.
// Then `$review:global` typed out sends the global body, and a price and a
// code span send no skill at all.
// Run: OPENCODE_DEV=<opencode checkout> SCENARIO_OUT=out bunx opencode-drive run scenarios/skills.ts
//
// It writes, under SCENARIO_OUT, `skills-popup.txt` (the popup on `$`),
// `-filtered.txt` (after `$rev`), `-picked.txt` (the composer after the pick),
// `-sent.txt` (the transcript after the first turn), `-done.txt` (after all
// three), `-timeout.txt` when a wait times out, `-requests.json` (each model
// request) and `-transcripts.json`; and a screenshot of the popup.
import { Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
const label = "skills"

const skill = (description: string, body: string) => `---\ndescription: ${description}\n---\n${body}\n`

const say = (text: string) => Stream.make(Llm.text(text), Llm.finish())
// Prime's look, wherever another change has moved it.
const prime = `${root}/cmd/prime`

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OPENCODE_DEV! },
    config: { autoupdate: false, username: "Demo", plugins: [`${root}/cmd/skills`] },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [prime, `${root}/cmd/skills`],
    },
    tui: { viewport: { cols: 150, rows: 50 } },
    project: {
      git: true,
      files: {
        ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8"),
        ".claude/skills/review/SKILL.md": skill("Review this project's change", "LOCAL-REVIEW-BODY: read the project's diff."),
        ".opencode/skills/review/SKILL.md": skill("Review any change, the user's way", "GLOBAL-REVIEW-BODY: read any diff."),
        ".opencode/skills/deploy/SKILL.md": skill("Ship to production", "DEPLOY-BODY: ship it."),
      },
    },
  },
  ({ ui, llm, opencode }) =>
    Effect.gen(function* () {
      const requests: Array<string> = []
      yield* llm.serve((request) => {
        const s = JSON.stringify(request)
        if (s.includes("You name conversations")) return say("Skills fixture")
        requests.push(s)
        return say(`Answered turn ${requests.length}`)
      })

      type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
      const text = (frame: Frame) => frame.lines.map((line) => line.spans.map((span) => span.text).join("").trimEnd()).join("\n")
      const dump = Effect.gen(function* () {
        writeFileSync(`${out}/${label}-requests.json`, JSON.stringify(requests, null, 2))
        const page = yield* opencode.session.list()
        const transcripts = yield* Effect.forEach(page.data, (session) =>
          opencode.session.context({ sessionID: session.id }).pipe(Effect.map((messages) => ({ id: session.id, title: session.title, messages }))),
        )
        writeFileSync(`${out}/${label}-transcripts.json`, JSON.stringify(transcripts, null, 2))
        // What the skill tool offers and what the popup read, beside each other.
        const registry = yield* opencode.skill.list().pipe(Effect.map((answer) => answer.data.map((skill) => ({ id: skill.id, path: skill.path }))), Effect.orElseSucceed(() => "unreadable"))
        const catalog = yield* opencode.rpc.call({ rpcID: "dotfiles-opencode.skills", method: "catalog", input: {} }).pipe(Effect.map((answer) => answer.output), Effect.catchCause((cause) => Effect.succeed(String(cause))))
        writeFileSync(`${out}/${label}-skills.json`, JSON.stringify({ registry, catalog }, null, 2))
      })
      const until = (ready: (frame: string) => boolean) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
          Effect.tapError(() =>
            ui.capture().pipe(
              Effect.map((frame) => writeFileSync(`${out}/${label}-timeout.txt`, text(frame))),
              Effect.andThen(dump),
            ),
          ),
        )
      const keep = (name: string) => ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${label}-${name}.txt`, text(frame))))

      // `$` opens the popup on the catalog: both reviews, tagged, and deploy.
      yield* until((frame) => frame.includes("gpt-sim-model"))
      yield* Effect.sleep("1 second")
      yield* ui.type("$")
      yield* until((frame) => frame.includes("global · shadowed") && frame.includes("deploy"))
      yield* keep("popup")
      console.log("screenshot:", yield* ui.screenshot(`${label}-popup`))
      yield* ui.type("rev")
      yield* until((frame) => !frame.includes("Ship to production") && frame.includes("global · shadowed"))
      yield* keep("filtered")
      // Enter takes the first row, the local review.
      yield* ui.press("return")
      // (Frame lines are trimmed, so the inserted trailing space does not show.)
      yield* until((frame) => frame.includes("┃ $review") && !frame.includes("global · shadowed"))
      yield* keep("picked")
      yield* ui.type("check the diff")
      yield* ui.press("return")
      yield* until((frame) => frame.includes("Answered turn 1"))
      yield* keep("sent")

      // Typed out, the qualified token loads the global copy.
      yield* ui.submit("now $review:global please")
      yield* until((frame) => frame.includes("Answered turn 2"))
      // A price and a code span load nothing.
      yield* ui.submit("it costs $5 and `$deploy` stays text")
      yield* until((frame) => frame.includes("Answered turn 3"))
      yield* keep("done")
      yield* dump
    }),
)
