// Jobs on the simulated host (sim/world.ts), at 20 seeds: tests/job.test.ts's
// name and the claims it reads off the model's requests, the transcript and
// the replies, moved off real OpenCode (it waited a real job's 3 s, a 10 s
// poll and 12 s past a kill). The plugin is `cmd/wake/server.ts`'s `make` on
// the world's context (sim/plugins.ts); its jobs are the runner's memory
// double, which this test drives as scenarios/job.ts's command would: it
// starts, prints, appends a progress line to $JOB_DRIP, and 3 s later prints
// its last line and exits 4. The server's poll finds the end on the world's
// clock. What only a real process shows (a detached process group, its log
// file, a kill's signal) stays in tests/job.test.ts and
// mods/wake/process/runner.test.ts.
import { Effect } from "effect"
import * as MemoryRunner from "@dotfiles/opencode-wake/memory/runner"
import * as Plugins from "../../sim/plugins.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/wake/job.sim.test.ts")

const WORK = "/scratch/project"
const KAPPA = `echo kappa-start; printf 'compiled\\n' >> "$JOB_DRIP"; sleep 3; echo KAPPA-DONE; exit 4`

/** scenarios/job.ts's model, its kill steps as they were at 3d449520: the reply to whatever came last in the conversation. */
const rules: ReadonlyArray<readonly [string, (text: string) => World.Reply]> = [
  ["step-job", () => World.call("call_job_kappa", "job", { command: KAPPA, note: "KAPPA: read the result" })],
  [
    "call_job_kappa",
    (text) => {
      if (/Job j[0-9a-z]{6} started/.test(text)) return World.say("Kappa job started.")
      return World.say("Kappa job refused.")
    },
  ],
  ["Note: KAPPA", () => World.say("Woke on kappa.")],
  ["step-kill", () => World.call("call_job_lambda", "job", { command: "sleep 300", note: "LAMBDA: should never wake" })],
  [
    "call_job_lambda",
    (text) => World.call("call_kill_lambda", "job", { action: "kill", id: /Job (j[0-9a-z]{6}) started/.exec(text.slice(text.lastIndexOf("call_job_lambda")))?.[1] ?? "missing" }),
  ],
  // The kill's answer carries the note too; only a letter opens with ⏰.
  [
    "call_kill_lambda",
    (text) => {
      const after = text.slice(text.lastIndexOf("call_kill_lambda"))
      if (after.includes("⏰ Job")) return World.say("Lambda woke after all.")
      if (after.includes("was killed")) return World.say("Lambda killed.")
      return World.say("Lambda not killed.")
    },
  ],
]

/** An assistant's text reply, alone; nothing for a tool call or another message. */
const replyText = (message: World.Message) => {
  if (message.type === "assistant" && message.text !== "") return [message.text]
  return []
}

/** A job's end letter: the synthetic message it came in, not a progress one. */
const endLetter = (message: World.Message) => {
  if (message.type === "synthetic" && message.metadata["kind"] === "job" && message.metadata["progress"] !== true) return [message]
  return []
}

/** The rule whose marker comes last in the conversation answers; with none, nothing to do. */
const reply = (text: string) => {
  const [last] = rules.map(([marker, respond]) => ({ at: text.lastIndexOf(marker), respond })).toSorted((left, right) => right.at - left.at)
  if (last === void 0 || last.at < 0) return World.say("Nothing to do.")
  return last.respond(text)
}

seeded("a job's end steers a letter with its exit, log tail and note into the idle session; a killed job wakes nobody", ({ seed, expect }) =>
  Effect.gen(function* () {
    const runner = MemoryRunner.empty()
    const world = World.make({
      seed,
      script: (request) => {
        if (request.kind === "title") return World.say("Job fixture")
        return reply(request.text)
      },
    })
    yield* world.load(Plugins.wake(world, runner), { directory: WORK, options: { backstop: "off" } })
    const session = yield* world.session(WORK)
    const idle = () => world.sessions.get(session)?.running !== true
    const replies = () => world.messages(session).flatMap(replyText)
    const root = () => world.asked().filter((request) => request.sessionID === session && request.kind === "primary").map((request) => request.text)
    const step = (text: string, done: () => boolean) => world.prompt(session, text).pipe(Effect.andThen(world.until(() => idle() && done(), 60_000)))
    const launched = (command: string) => [...runner.jobs.values()].find((job) => job.spec.command === command)

    // The job runs outside the server: the command, as the runner would run it.
    yield* step("step-job", () => replies().some((text) => text.startsWith("Kappa job")))
    const kappa = launched(KAPPA)
    expect(kappa).toBeDefined()
    const id = kappa?.spec.id ?? ""
    MemoryRunner.running(runner, id, world.now())
    if (kappa !== void 0) {
      kappa.log = "kappa-start\n"
      kappa.drip = "compiled\n"
    }
    yield* world.advance(3_000)
    if (kappa !== void 0) kappa.log += "KAPPA-DONE\n"
    MemoryRunner.ended(runner, id, 4, world.now())
    // The server's poll finds the end; the letter wakes the idle session.
    yield* world.until(() => idle() && replies().includes("Woke on kappa."), 60_000)

    // The receipt: the id, the log, and that the end letter will come.
    const receipt = root().find((text) => text.includes("call_job_kappa") && /Job j[0-9a-z]{6} started\. Log: /.test(text)) ?? ""
    expect(receipt).toContain("in its own process group")
    expect(receipt).toContain("$JOB_DRIP")
    // The letter: the exit, the log tail, the note, and the progress line.
    const letter = root().find((text) => text.includes("Note: KAPPA")) ?? ""
    expect(letter).toMatch(/⏰ Job j[0-9a-z]{6} exited 4 after \d+s: `echo kappa-start/)
    expect(letter).toContain("Note: KAPPA: read the result")
    expect(letter).toContain("kappa-start\nKAPPA-DONE")
    expect(letter).toContain("compiled")
    expect(replies()).toContain("Kappa job started.")
    expect(replies()).toContain("Woke on kappa.")

    // The kill: answered killed, and no letter came, past a poll and more.
    yield* step("step-kill", () => replies().some((text) => text.startsWith("Lambda")))
    yield* world.advance(12_000)
    expect(replies()).toContain("Lambda killed.")
    expect(replies().filter((text) => text.startsWith("Lambda"))).toEqual(["Lambda killed."])
    expect(runner.killed).toEqual([launched("sleep 300")?.spec.id ?? "missing"])
    expect(root().some((text) => /⏰ Job j[0-9a-z]{6} [^\n]*`sleep 300`/.test(text))).toBe(false)

    const letters = world.messages(session).flatMap(endLetter)
    expect(letters.map((message) => message.metadata["exitCode"])).toEqual([4])
    // The progress line is the letter's own, under its heading (the command's text names it too, so the request's would not tell).
    expect(letters[0]?.text).toContain("Progress ($JOB_DRIP):\ncompiled")
    expect(world.stale()).toEqual([])
  }),
)
