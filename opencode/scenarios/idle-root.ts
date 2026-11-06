// An idle root with ready work, in real OpenCode with the orchestrate,
// status and queue plugins and a scripted model. The project holds an
// orchestrate run `p1` with two units: `alpha` in implement and `beta` in
// plan. The root starts `planner alpha r1` in the background, which makes the
// run its own, and ends its turn: the planner still runs, so no nudge. While
// the planner works, the owner types into the composer and leaves it there;
// the planner finishes, its notice wakes the root, the root answers and goes
// idle, and the draft holds the nudge. The owner clears the composer: the
// root is steered with one line, and answers it by naming its wait as a
// queue item, which the sidebar shows. Going idle after that does not nudge
// again, and the owner's next prompt (new input) finds the wait named, so
// still no second nudge.
// Run: OPENCODE_DEV=<opencode checkout> SCENARIO_OUT=out bunx opencode-drive run scenarios/idle-root.ts
//
// It writes, under SCENARIO_OUT:
// - `idle-root-started.txt`: the root idle with its planner running;
// - `idle-root-drafted.txt`: the root idle again after the notice, the draft in the composer;
// - `idle-root-nudged.txt`: after the draft cleared, the nudge and the root's answer;
// - `idle-root-final.txt`: after the owner's next prompt;
// - `idle-root-requests.json`: each root request's last message text, in order;
// - `idle-root-timeout.txt` when a wait times out.
import { Deferred, Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
const label = "idle-root"

export const LINE = "idle with units ready: alpha, beta; start them or name what you wait on."
const PLANNER = { agent: "planner", description: "planner alpha r1", prompt: "Plan alpha now.", background: true }
const DRAFT = "half a thought"
const WAIT = { set: [{ id: "owner-review", text: "Owner review of alpha", state: "waiting", detail: "owner" }] }

type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
const text = (frame: Frame) => frame.lines.map((line) => line.spans.map((span) => span.text).join("").trimEnd()).join("\n")

/** A request's last message, as text: what the model answers. */
const lastOf = (request: unknown): string => {
  const messages = (request as { readonly body?: { readonly messages?: ReadonlyArray<unknown> } }).body?.messages ?? []
  return JSON.stringify(messages.at(-1) ?? request)
}

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OPENCODE_DEV! },
    config: {
      autoupdate: false,
      username: "Demo",
      plugins: [
        // A Wednesday afternoon, so the Sabbath never holds a start.
        { package: `${root}/cmd/orchestrate`, options: { now: "2026-11-04T15:00:00Z", log: `${out}/${label}-agents.jsonl` } },
        { package: `${root}/cmd/status`, options: { log: `${out}/${label}-agents.jsonl`, statusScript: join(root, "../skills/orchestrate/scripts/status.ts") } },
        { package: `${root}/cmd/queue`, options: { dir: `${out}/${label}-queues` } },
      ],
    },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${root}/cmd/prime`, `${root}/cmd/queue`, `${root}/cmd/orchestrate`],
    },
    tui: { viewport: { cols: 170, rows: 50 } },
    project: {
      git: true,
      files: {
        ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8"),
        "tmp/orchestrate/p1/alpha/log.md": "2026-11-04T15:00Z plan → implement r1 spec.md\n",
        "tmp/orchestrate/p1/beta/log.md": "2026-11-04T15:00Z start → plan r1 plan.md\n",
        "tmp/orchestrate/p1/gamma/log.md": "2026-11-04T15:00Z integration-check → merged abcdef1 r1 accept.log\n",
      },
    },
  },
  ({ ui, llm }) =>
    Effect.gen(function* () {
      const finished = yield* Deferred.make<void>()
      const requests: Array<string> = []
      yield* llm.serve((request) => {
        const s = JSON.stringify(request)
        if (s.includes("You name conversations")) return Stream.make(Llm.text("Idle fixture"), Llm.finish())
        // The planner works until the scenario lets it finish.
        if (s.includes(PLANNER.prompt) && !s.includes("idle-fixture"))
          return Stream.fromEffect(Deferred.await(finished)).pipe(Stream.drain, Stream.concat(Stream.make(Llm.text("alpha planned"), Llm.finish())))
        const last = lastOf(request)
        requests.push(last)
        if (last.includes("status-check")) return Stream.make(Llm.text("Still waiting on the owner's review."), Llm.finish())
        if (s.includes(LINE))
          return s.includes("call_wait")
            ? Stream.make(Llm.text("Named the wait."), Llm.finish())
            : Stream.make(Llm.toolCall({ index: 0, id: "call_wait", name: "queue", input: WAIT }), Llm.finish("tool-calls"))
        // The planner's notice.
        if (last.includes("alpha planned")) return Stream.make(Llm.text("Alpha's plan is in."), Llm.finish())
        if (!s.includes("call_start")) return Stream.make(Llm.toolCall({ index: 0, id: "call_start", name: "subagent", input: PLANNER }), Llm.finish("tool-calls"))
        return Stream.make(Llm.text("Started alpha's planner."), Llm.finish())
      })
      const until = (ready: (frame: string) => boolean, times = 300) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times }),
          Effect.tapError(() => ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${label}-timeout.txt`, text(frame))))),
        )
      const save = (name: string) => ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${label}-${name}.txt`, text(frame))))

      yield* ui.submit("idle-fixture")
      yield* until((frame) => frame.includes("Started alpha's planner."))
      // Long enough for a nudge to land, were the running planner not holding it.
      yield* Effect.sleep("3 seconds")
      yield* save("started")

      yield* ui.type(DRAFT)
      yield* until((frame) => frame.includes(DRAFT))
      // Long enough for the TUI's report to reach the server before the root goes idle again.
      yield* Effect.sleep("1 second")
      yield* Deferred.succeed(finished, undefined)
      yield* until((frame) => frame.includes("Alpha's plan is in."))
      yield* Effect.sleep("4 seconds")
      yield* save("drafted")

      for (const _ of DRAFT) yield* ui.press("backspace")
      yield* until((frame) => frame.includes("Named the wait.") && frame.includes("Owner review of alpha"))
      yield* Effect.sleep("3 seconds")
      yield* save("nudged")

      yield* ui.submit("status-check")
      yield* until((frame) => frame.includes("Still waiting on the owner's review."))
      yield* Effect.sleep("3 seconds")
      yield* save("final")
      writeFileSync(`${out}/${label}-requests.json`, JSON.stringify(requests, null, 2))
      console.log("screenshot:", yield* ui.screenshot(label))
    }),
)
