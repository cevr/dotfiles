// The questions plugin in real OpenCode (the fork, through its SDK) on the
// scripted model, with two project directories open on one server, as the
// owner's servers have: the plugin is loaded once per directory. A question
// asked in one directory and answered through the /answer form is recorded
// and sent by that directory's plugin alone: one letter, and no other copy
// finding the question already closed (`questions: the form's answers were
// not recorded … NotOpen`, which a submit logged once per other directory).
// The same run has a root session and a subagent of it: the subagent's
// question, answered in the root's form, wakes the subagent with the letter,
// and the root, not woken, reads a notice of it at its next turn.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Result, Spec } from "./questions/run.ts"
import { ANSWERED, IDLE, LETTER, NOTICE, ROOT_TOLD } from "./questions/sim.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/questions-locations.test.ts: skipped. Set OPENCODE_DEV to the fork.")

const ROOT = resolve(import.meta.dir, "..")
const scratch = mkdtempSync(join(tmpdir(), "questions-locations-"))
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

interface Message {
  readonly type?: string
  readonly metadata?: { readonly source?: string }
}
const messagesOf = (context: unknown): ReadonlyArray<Message> => {
  const list = Array.isArray(context) ? context : (context as { messages?: unknown }).messages
  return Array.isArray(list) ? (list as ReadonlyArray<Message>) : []
}

/** The one run both tests read. */
let once: Promise<Result> | undefined
const shared = () => (once ??= run())

describe.skipIf(!fork)("questions with two directories open on one server", () => {
  test("one form submit: one letter in the asking session, no copy of the plugin finds the question closed", async () => {
    const result = await shared()
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

  test("a subagent's question, answered in its root's form: the subagent wakes on the answer, the root reads a notice at its next turn", async () => {
    const { subagent, warnings } = await shared()
    // The root's form keys the subagent's question by the subagent's session.
    expect(subagent.field).toMatch(/^ask_user_async:ses_\w+:q1$/)
    // The letter went to the subagent, which woke and read it.
    expect(messagesOf(subagent.child).filter((message) => message.metadata?.source === "questions")).toHaveLength(1)
    expect(JSON.stringify(subagent.child)).toContain(LETTER)
    expect(JSON.stringify(subagent.child)).toContain(ANSWERED)
    // The notice did not wake the root; its next turn read it.
    expect(JSON.stringify(subagent.untold)).not.toContain(ROOT_TOLD)
    expect(JSON.stringify(subagent.root)).toContain(NOTICE)
    expect(JSON.stringify(subagent.root)).toContain(ROOT_TOLD)
    expect(JSON.stringify(subagent.root)).not.toContain(LETTER)
    expect(warnings.filter((warning) => warning.message.startsWith("questions:"))).toEqual([])
  }, 150_000)
})
