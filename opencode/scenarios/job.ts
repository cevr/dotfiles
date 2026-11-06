// Jobs in real OpenCode, with a scripted model, in the Prime look:
// - step-job: the root runs a job (a shell command that writes a progress line,
//   sleeps 3 s and exits 4) and ends its turn; the job's end steers a letter
//   with the exit, the log tail and the note into the idle session, and the
//   model answers it.
// - step-kill: the root runs `sleep 300` as a job, then kills it; the kill's
//   answer says it was killed, and no letter follows.
// Run: OPENCODE_DEV=<opencode checkout> SCENARIO_OUT=out bunx opencode-drive run scenarios/job.ts
//
// The backstop is `off`, so the runner calls no service when the job ends and
// the server's poll (every 10 s) finds the end. The jobs run as real
// processes, detached, under the instance's own XDG_STATE_HOME.
//
// It writes, under SCENARIO_OUT, `job-<name>.txt` for each kept frame
// (`started`, `kappa`, `killed`), `job-timeout.txt` when a wait times out,
// `job-requests.json` and `job-transcripts.json`.
import { Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"

type ToolInput = Parameters<typeof Llm.toolCall>[0]["input"]
const call = (id: string, name: string, input: ToolInput) => Stream.make(Llm.toolCall({ index: 0, id, name, input }), Llm.finish("tool-calls"))
const say = (text: string) => Stream.make(Llm.text(text), Llm.finish())

const KAPPA = `echo kappa-start; printf 'compiled\\n' >> "$JOB_DRIP"; sleep 3; echo KAPPA-DONE; exit 4`

const rules: ReadonlyArray<readonly [string, (request: string) => Stream.Stream<Llm.Output>]> = [
  ["step-job", () => call("call_job_kappa", "job", { command: KAPPA, note: "KAPPA: read the result" })],
  ["call_job_kappa", (s) => say(/Job j[0-9a-z]{6} started/.test(s) ? "Kappa job started." : "Kappa job refused.")],
  ["Note: KAPPA", () => say("Woke on kappa.")],
  ["step-kill", () => call("call_job_lambda", "job", { command: "sleep 300", note: "LAMBDA: should never wake" })],
  [
    "call_job_lambda",
    (s) => {
      const id = /Job (j[0-9a-z]{6}) started/.exec(s.slice(s.lastIndexOf("call_job_lambda")))?.[1] ?? "missing"
      return call("call_kill_lambda", "job", { action: "kill", id })
    },
  ],
  // The kill's answer carries the note too; only a letter opens with ⏰.
  [
    "call_kill_lambda",
    (s) => {
      const after = s.slice(s.lastIndexOf("call_kill_lambda"))
      if (after.includes("⏰ Job")) return say("Lambda woke after all.")
      return say(after.includes("was killed") ? "Lambda killed." : "Lambda not killed.")
    },
  ],
]
const reply = (s: string) => {
  const last = rules.map(([marker, respond]) => ({ at: s.lastIndexOf(marker), respond })).toSorted((left, right) => right.at - left.at)[0]
  return last === undefined || last.at < 0 ? say("Nothing to do.") : last.respond(s)
}

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OPENCODE_DEV! },
    config: { autoupdate: false, username: "Demo", plugins: [{ package: `${root}/cmd/wake`, options: { backstop: "off" } }] },
    tuiConfig: {
      animations: false,
      tabs: { mode: "off" },
      theme: { name: "prime", mode: "dark" },
      plugins: [`${root}/cmd/prime`],
    },
    tui: { viewport: { cols: 150, rows: 50 } },
    project: { git: true, files: { ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8") } },
  },
  ({ ui, llm, opencode }) =>
    Effect.gen(function* () {
      const requests: Array<{ readonly session: "root" | "title"; readonly at: number; readonly request: string }> = []
      yield* llm.serve((request) => {
        const s = JSON.stringify(request)
        const title = s.includes("You name conversations")
        requests.push({ session: title ? "title" : "root", at: Date.now(), request: s })
        return title ? say("Job fixture") : reply(s)
      })

      type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
      const text = (frame: Frame) => frame.lines.map((line) => line.spans.map((span) => span.text).join("").trimEnd()).join("\n")
      const dump = Effect.gen(function* () {
        writeFileSync(`${out}/job-requests.json`, JSON.stringify(requests, null, 2))
        const page = yield* opencode.session.list()
        const transcripts = yield* Effect.forEach(page.data, (session) =>
          opencode.session.context({ sessionID: session.id }).pipe(Effect.map((messages) => ({ id: session.id, parentID: session.parentID, title: session.title, messages }))),
        )
        writeFileSync(`${out}/job-transcripts.json`, JSON.stringify(transcripts, null, 2))
      })
      const until = (ready: (frame: string) => boolean, times = 300) =>
        ui.capture().pipe(
          Effect.flatMap((frame) => (ready(text(frame)) ? Effect.void : Effect.fail("pending"))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times }),
          Effect.tapError(() => ui.capture().pipe(Effect.map((frame) => writeFileSync(`${out}/job-timeout.txt`, text(frame))), Effect.andThen(dump))),
        )
      const keep = (name: string, screenshot = false) =>
        Effect.gen(function* () {
          const { images: _, ...frame } = yield* ui.capture()
          writeFileSync(`${out}/job-${name}.txt`, text(frame))
          if (screenshot) console.log("screenshot:", yield* ui.screenshot(`job-${name}`))
        })

      // A job runs outside the server; its end wakes the idle session.
      yield* ui.submit("step-job")
      yield* until((frame) => frame.includes("Kappa job started.") || frame.includes("Kappa job refused."))
      yield* keep("started")
      yield* until((frame) => frame.includes("Woke on kappa."), 400)
      yield* keep("kappa", true)

      // A killed job answers killed, and wakes nobody.
      yield* ui.submit("step-kill")
      yield* until((frame) => frame.includes("Lambda killed.") || frame.includes("Lambda not killed."), 400)
      // Past a poll, room for a letter were there one.
      yield* Effect.sleep("12 seconds")
      yield* keep("killed")
      yield* dump
    }),
)
