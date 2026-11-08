// Public UI seam: real OpenCode, the real questions plugin (and the real
// kernel), a scripted model that asks through `ask_user_async` directly or
// from a kernel cell, and a background subagent that asks too. The tray and
// the /answer pane are read off the frame; the answers off the next model
// requests and the transcripts.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { owned } from "./owned.ts"

const RECEIPT = [
  "Asked in the background; nobody has answered yet:",
  "- q1: Which database should the cache use? · assuming SQLite",
  "- q2: Should the old /v1 endpoint stay for a release? · assuming Keep it",
  "Continue on your assumption now.",
].join("\n")

const LETTER = [
  "Q: Which database should the cache use?",
  "You assumed: SQLite",
  "A: Redis",
  "This differs from your assumption: revise the work that rests on it, and say what you changed.",
].join("\n")

/** The frame's lines, without the sidebar's column. */
const lines = (frame: string): ReadonlyArray<string> => frame.split("\n").map((line) => line.slice(0, 108).trim())

interface Request {
  readonly session: "root" | "subagent" | "title"
  readonly request: string
}

interface Part {
  readonly type?: string
  readonly name?: string
}
interface Session {
  readonly id: string
  readonly parentID?: string
  readonly messages: ReadonlyArray<{ readonly type?: string; readonly content?: ReadonlyArray<Part> | string; readonly metadata?: { readonly source?: string } }>
}

/** What the model read: the JSON-escaped request, unescaped enough to read its strings. */
const unescaped = (request: string) => request.replaceAll("\\n", "\n").replaceAll('\\"', '"')

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/questions.test.ts: skipped. Set OPENCODE_DEV to the fork.")
describe.skipIf(!fork)("background questions", () => {
  for (const via of ["direct", "kernel"] as const)
    test(`asked ${via === "direct" ? "through ask_user_async" : "from a kernel cell"}: the tray, /answer, the answers' letters and a dismissal`, async () => {
      const out = mkdtempSync(join(tmpdir(), `questions-${via}-`))
      const child = owned(["bunx", "opencode-drive", "run", "scenarios/questions.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, SCENARIO_OUT: out, QUESTIONS_VIA: via, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      const read = (name: string) => readFileSync(join(out, `questions-${via}-${name}`), "utf8")
      const timeout = join(out, `questions-${via}-timeout.txt`)
      if (code !== 0) throw new Error(`questions scenario (${via}) exited ${code}:\n${(stdout + stderr).slice(-5000)}\n${existsSync(timeout) ? readFileSync(timeout, "utf8") : ""}`)
      expect(stdout).toMatch(/screenshot: .*questions-.*-pane\.png/)

      // The root's tray counts its own two and its subagent's one, oldest first.
      expect(lines(read("tray.txt"))).toContain("? 3 open questions · Cache store, Old endpoint, Test runner · shift+← /answer")

      // /answer: the oldest question, the cursor on the assumed choice, a row to type in, the keys.
      const pane = lines(read("pane.txt"))
      expect(pane).toContain("? Question 1/3 · Cache store · asked just now")
      const at = pane.indexOf("Which database should the cache use?")
      expect(pane.slice(at, at + 5)).toEqual([
        "Which database should the cache use?",
        "▸ SQLite  assumed · one file, no server",
        "Redis",
        "Type your own answer",
        "↑↓ move · enter answer · type your own · ctrl+x dismiss · esc close",
      ])
      expect(pane.some((line) => line.includes("open question"))).toBe(false)
      const moved = lines(read("moved.txt"))
      expect(moved).toContain("▸ Redis")
      expect(moved).toContain("SQLite  assumed · one file, no server")

      // Enter on Redis: the idle root wakes on the letter, drawn as one notice; the next question shows.
      const typed = lines(read("typed.txt"))
      expect(typed).toContain("◈ answered · Which database should the cache use? → Redis")
      expect(typed).toContain("Root switched the cache to Redis")
      expect(typed).toContain("? Question 1/2 · Old endpoint · asked just now")
      // No choices: the assumption is the one row; typing takes the cursor to the typed row.
      expect(typed).toContain("Keep it  assumed")
      expect(typed).toContain("▸ Drop it after this release")
      // The typed text went to the pane, not the prompt.
      expect(typed[typed.findIndex((line) => line.startsWith("Details mode")) + 1]).toBe("┃")

      // The subagent's question shows in the root's pane, naming who asked.
      const subagent = lines(read("subagent.txt"))
      expect(subagent).toContain("◈ answered · Should the old /v1 endpoint stay for a release? → Drop it after this release")
      expect(subagent).toContain("? Question 1/1 · Test runner · from general · asked just now")
      expect(subagent).toContain("▸ bun test  assumed")
      // ctrl+x arms; the second dismisses, and the pane goes with the last question.
      expect(lines(read("armed.txt"))).toContain("ctrl+x again dismisses this question; the agent is not told")
      const done = lines(read("done.txt"))
      expect(done.some((line) => line.includes("Question 1/") || line.includes("open question"))).toBe(false)
      // The prompt has the focus back.
      expect(done).toContain("┃ typed-after-answer")

      const requests: ReadonlyArray<Request> = JSON.parse(read("requests.json"))
      const root = requests.filter((request) => request.session === "root").map((request) => unescaped(request.request))
      // The tool answers at once with the ids and assumptions, and the root carries on.
      expect(root.some((request) => request.includes(RECEIPT))).toBe(true)
      const lettered = root.findIndex((request) => request.includes("Answer to your background question q1"))
      expect(lettered).toBeGreaterThan(0)
      expect(root[lettered]).toContain(LETTER)
      expect(root.some((request) => request.includes("A: Drop it after this release\nThis differs from your assumption"))).toBe(true)
      // The dismissal tells nobody: the subagent never reads an answer.
      const asked = requests.filter((request) => request.session === "subagent").map((request) => unescaped(request.request))
      expect(asked.some((request) => request.includes("- q1: Which test runner should the suite use? · assuming bun test"))).toBe(true)
      expect(asked.some((request) => request.includes("Answer to your background question"))).toBe(false)

      // Each answer is one synthetic message in the root, its source `questions`; a kernel cell leaves no ask_user_async part.
      const sessions: ReadonlyArray<Session> = JSON.parse(read("transcripts.json"))
      const rootSession = sessions.find((session) => session.parentID === undefined || session.parentID === null)
      expect(rootSession?.messages.filter((message) => message.type === "synthetic" && message.metadata?.source === "questions")).toHaveLength(2)
      const tools = sessions.flatMap((session) =>
        session.messages.flatMap((message) => (Array.isArray(message.content) ? message.content.flatMap((part) => (part.type === "tool" && part.name !== undefined ? [part.name] : [])) : [])),
      )
      if (via === "kernel") expect(tools).not.toContain("ask_user_async")
      else expect(tools.filter((name) => name === "ask_user_async")).toHaveLength(2)
      console.log(`Questions (${via}) artifacts: ${out}`)
    }, 150_000)
})

describe.skipIf(!fork)("the /answer pane holds its place", () => {
  test("shift+← opens it on an empty composer and selects in a full one; the cursor, the arm and typed text hold across readings", async () => {
    const out = mkdtempSync(join(tmpdir(), "questions-hold-"))
    const child = owned(["bunx", "opencode-drive", "run", "scenarios/questions-hold.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    const read = (name: string) => lines(readFileSync(join(out, `questions-hold-${name}.txt`), "utf8"))
    const timeout = join(out, "questions-hold-timeout.txt")
    if (code !== 0) throw new Error(`questions-hold scenario exited ${code}:\n${(stdout + stderr).slice(-5000)}\n${existsSync(timeout) ? readFileSync(timeout, "utf8") : ""}`)

    // The tray names the hotkey beside the command.
    expect(read("tray")).toContain("? 1 open question · Cache store · assuming SQLite · shift+← /answer")
    // With text in the composer shift+← is the composer's: it selected the last character, which typing replaced, and the pane stayed shut.
    const selecting = read("selecting")
    expect(selecting).toContain("┃ holdtexZ")
    expect(selecting.some((line) => line.includes("Question 1/"))).toBe(false)
    // On an empty composer shift+← opens the pane, on the assumption.
    expect(read("pane")).toContain("? Question 1/1 · Cache store · asked just now")
    expect(read("pane")).toContain("▸ SQLite  assumed")
    expect(read("moved")).toContain("▸ Memcached")

    // The subagent asked (a changed event, a longer list) and two ticks passed: the cursor is still on the third choice.
    const held = read("held")
    const at = held.indexOf("Which store should the cache use?")
    expect(held.some((line) => line.startsWith("? Question 1/2 · Cache store"))).toBe(true)
    expect(held.slice(at, at + 6)).toEqual(["Which store should the cache use?", "SQLite  assumed", "Redis", "▸ Memcached", "Postgres", "Type your own answer"])
    // The arm and the typed answer outlast a tick.
    expect(read("armed")).toContain("ctrl+x again dismisses this question; the agent is not told")
    expect(read("armed")).toContain("▸ Memcached")
    expect(read("typed")).toContain("▸ Use Postgres with a TTL")

    // Answered, the pane moves to the next question: on its assumption, nothing typed, nothing armed.
    const next = read("next")
    expect(next).toContain("◈ answered · Which store should the cache use? → Use Postgres with a TTL")
    expect(next.some((line) => line.startsWith("? Question 1/1 · Test runner · from general"))).toBe(true)
    expect(next).toContain("▸ bun test  assumed")
    expect(next).toContain("Type your own answer")
    expect(next).toContain("↑↓ move · enter answer · type your own · ctrl+x dismiss · esc close")
    expect(read("done")).toContain("? 1 open question · Test runner · assuming bun test · shift+← /answer")
    console.log(`Questions hold artifacts: ${out}`)
  }, 150_000)
})
