// The questions plugin in real OpenCode (the fork, through its SDK) on the
// scripted model, with two project directories open on one server, as the
// owner's servers have: the plugin is loaded once per directory. A question
// asked in one directory and answered through the /answer form is recorded
// and sent by that directory's plugin alone: one letter, and no other copy
// finding the question already closed (`questions: the form's answers were
// not recorded … NotOpen`, which a submit logged once per other directory).
// The same test runs on the simulated host
// (cmd/questions/questions-locations.sim.test.ts); it stays here too while no
// host law pins where a form's reply is heard (tests/parity/subagents.json).
// The subagent's question, answered in its root's form, moved there.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { Result, Spec } from "./questions/run.ts"
import { ANSWERED, IDLE, LETTER, messagesOf } from "./questions/sim.ts"
import { scratch as scratchDir } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/questions-locations.test.ts: skipped. Set OPENCODE_DEV to the fork.")

const ROOT = resolve(import.meta.dir, "..")
const scratch = scratchDir("questions-locations-").path
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** One run of real OpenCode in a scratch home; see tests/questions/run.ts. */
const run = async (): Promise<Result> => {
  const base = join(scratch, "run")
  const home = join(base, "home")
  mkdirSync(home, { recursive: true })
  const file = join(base, "spec.json")
  writeFileSync(file, JSON.stringify({ base, fork: resolve(fork ?? ""), plugin: join(ROOT, "cmd/questions") } satisfies Spec))
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "questions/run.ts"), file], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      OPENCODE_DISABLE_MODELS_FETCH: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 120_000)
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  await child.exited
  clearTimeout(timer)
  const result = join(base, "result.json")
  if (child.exitCode !== 0 || !existsSync(result)) throw new Error(`the questions run failed (exit ${child.exitCode}):\n${stdout}\n${stderr}`)
  return JSON.parse(readFileSync(result, "utf8")) as Result
}

describe.skipIf(!fork)("questions with two directories open on one server", () => {
  test("one form submit: one letter in the asking session, no copy of the plugin finds the question closed", async () => {
    const result = await run()
    const letters = messagesOf(result.asked).filter((message) => message.metadata?.source === "questions")
    expect(letters).toHaveLength(1)
    expect(JSON.stringify(result.asked)).toContain(LETTER)
    // The letter woke the session, and it read the answer.
    expect(JSON.stringify(result.asked)).toContain(ANSWERED)
    // The other directory's session is untouched.
    expect(messagesOf(result.other).some((message) => message.metadata?.source === "questions")).toBe(false)
    expect(JSON.stringify(result.other)).toContain(IDLE)
    expect(result.warnings.filter((warning) => warning.message.startsWith("questions:"))).toEqual([])
  }, 150_000)
})
