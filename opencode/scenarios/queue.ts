// The Queue section of the sidebar, kept by a scripted model through the
// `queue` tool: directly (QUEUE_VIA=direct, the default) or from a kernel
// cell (QUEUE_VIA=kernel, the kernel as the agent's runtime, as daily loads
// it), with the orchestrate plugin giving the subagents their roles. The
// model starts a background implementor, sets the queue with an item linked
// to its session, starts a second (untyped, so orchestrate's worker) that no
// item names, and later marks one item done. Each subagent thinks one thought
// and waits. The sidebar draws only the items; Prime's rows beneath the
// composer draw both subagents.
// Run: OPENCODE_DEV=<opencode checkout> SCENARIO_OUT=out QUEUE_VIA=kernel bunx opencode-drive run scenarios/queue.ts
//
// It writes, under SCENARIO_OUT, `queue-<via>-set.txt` (the frame after the
// set), `queue-<via>-patched.txt` (after the patch), `queue-<via>-timeout.txt`
// when a wait times out, and `queue-<via>-transcript.json` (the root session's
// messages, to check which calls are tool parts).
import { Deferred, Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
const via = process.env.QUEUE_VIA === "kernel" ? "kernel" : "direct"
const label = `queue-${via}`

const MONEY = { description: "Fix money parsing", prompt: "Worker brief money.", agent: "implementor", background: true }
const FORGOTTEN = { description: "Forgotten worker", prompt: "Worker brief forgotten.", background: true }
/** What each subagent thinks before it waits: its row's update. */
const THOUGHTS: ReadonlyArray<readonly [string, string]> = [
  [MONEY.prompt, "Check the money parser first. Then run the tests."],
  [FORGOTTEN.prompt, "Read the forgotten brief first. Then report."],
]

// Tomorrow at 09:30 local, so the row reads `◷ <Mon> <d> 09:30`.
const tomorrow = new Date()
tomorrow.setDate(tomorrow.getDate() + 1)
tomorrow.setHours(9, 30, 0, 0)

const items = (money: string): Array<Record<string, string>> => [
  { id: "panes", text: "Close old Claude panes", state: "needs-you" },
  // Linked: the sidebar shows the worker's live state, not `next`.
  { id: "money", text: "Money parsing worker", state: "next", session: money },
  { id: "manna", text: "manna brainstorm", state: "waiting", owner: "other", who: "wC:p6" },
  { id: "token", text: "pool-token check", state: "scheduled", at: tomorrow.toISOString() },
  { id: "daily", text: "Merge workers, run daily", state: "next" },
  { id: "folder", text: "Missing-folder fix", state: "done" },
]
const PATCH = { upsert: [{ id: "panes", state: "done" }] }

/** One step's call: the tool itself, or a kernel cell running `code`. */
type ToolInput = Parameters<typeof Llm.toolCall>[0]["input"]
const call = (id: string, direct: ReadonlyArray<{ readonly name: string; readonly input: ToolInput }>, code: string) =>
  via === "kernel"
    ? [Llm.toolCall({ index: 0, id, name: "kernel", input: { code } })]
    : direct.map((tool, index) => Llm.toolCall({ index, id: index === 0 ? id : `${id}_${index}`, name: tool.name, input: tool.input }))

const step = (...parts: ReadonlyArray<ReturnType<typeof Llm.toolCall>>) => Stream.make(...parts, Llm.finish("tool-calls"))

type Entry = string | { readonly package: string; readonly options: Readonly<Record<string, string>> }
const plugins: Array<Entry> = [
  { package: `${root}/cmd/queue`, options: { dir: `${out}/${label}-queues` } },
  // A Wednesday afternoon, so the Sabbath never stops the subagents.
  { package: `${root}/cmd/orchestrate`, options: { now: "2026-11-04T15:00:00Z", log: `${out}/${label}-agents.jsonl` } },
  ...(via === "kernel" ? [`${root}/cmd/kernel`] : []),
]

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OPENCODE_DEV! },
    config: { autoupdate: false, username: "Demo", plugins },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${root}/cmd/prime`, `${root}/cmd/queue`],
    },
    tui: { viewport: { cols: 150, rows: 50 } },
    project: { git: true, files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") } },
  },
  ({ ui, llm, opencode }) =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      yield* llm.serve((request) => {
        const s = JSON.stringify(request)
        if (s.includes("You name conversations")) return Stream.make(Llm.text("Queue fixture"), Llm.finish())
        // The subagents think, then wait until the scenario is done, so they stay running.
        if (!s.includes("queue-fixture")) {
          const thought = THOUGHTS.find(([prompt]) => s.includes(prompt))?.[1] ?? "Thinking."
          return Stream.make(Llm.reasoning(thought)).pipe(
            Stream.concat(Stream.fromEffect(Deferred.await(release)).pipe(Stream.drain)),
            Stream.concat(Stream.make(Llm.text("worker done"), Llm.finish())),
          )
        }
        if (s.includes("queue-patch")) {
          if (!s.includes("call_patch")) return step(...call("call_patch", [{ name: "queue", input: PATCH }], `await tools.queue(${JSON.stringify(PATCH)})`))
          return Stream.make(Llm.text("Patched the queue"), Llm.finish())
        }
        if (!s.includes("call_start")) return step(...call("call_start", [{ name: "subagent", input: MONEY }], `await tools.subagent(${JSON.stringify(MONEY)})`))
        if (!s.includes("call_set")) {
          const money = /sessionID[^A-Za-z0-9]{1,12}(ses_[A-Za-z0-9]+)/.exec(s)?.[1]
          if (money === undefined) return Stream.make(Llm.text("No session id in the worker's result"), Llm.finish())
          const set = { set: items(money) }
          return step(
            ...call(
              "call_set",
              [
                { name: "queue", input: set },
                { name: "subagent", input: FORGOTTEN },
              ],
              `await tools.queue(${JSON.stringify(set)}); await tools.subagent(${JSON.stringify(FORGOTTEN)})`,
            ),
          )
        }
        return Stream.make(Llm.text("Queue fixture ready"), Llm.finish())
      })
      type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
      const text = (frame: Frame) => frame.lines.map((line) => line.spans.map((span) => span.text).join("").trimEnd()).join("\n")
      const until = (ready: (frame: string) => boolean) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 200 }),
          Effect.tapError(() => ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/${label}-timeout.txt`, text(frame))))),
        )
      yield* ui.submit("queue-fixture")
      yield* until(
        (frame) =>
          frame.includes("Queue fixture ready") &&
          frame.includes("● Money parsing worker") &&
          /^ ◆ implementor +Fix money parsing /m.test(frame) &&
          /^ ◆ worker +Forgotten worker /m.test(frame),
      )
      writeFileSync(`${out}/${label}-set.txt`, text(yield* ui.capture()))
      yield* ui.submit("queue-patch")
      yield* until((frame) => frame.includes("Patched the queue") && frame.includes("✓ Close old Claude panes"))
      writeFileSync(`${out}/${label}-patched.txt`, text(yield* ui.capture()))
      console.log("screenshot:", yield* ui.screenshot(label))
      // The root session's messages: which of the calls left a tool part.
      const page = yield* opencode.session.list()
      const roots = page.data.filter((session) => !session.parentID)
      const transcript = yield* Effect.forEach(roots, (session) => opencode.session.context({ sessionID: session.id }))
      writeFileSync(`${out}/${label}-transcript.json`, JSON.stringify(transcript, null, 2))
      yield* Deferred.succeed(release, undefined)
    }),
)
