// Public UI seam: real OpenCode, the real questions plugin (and the real
// kernel), a scripted model that asks through `ask_user_async` directly or
// from a kernel cell, and a background subagent that asks too. The tray and
// the host's question form that /answer opens are read off the frame; the
// answers off the next model requests and the transcripts.
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

/** The one letter for the first submit: both answers, and one line naming what to revise. */
const LETTER = [
  "Which database should the cache use?",
  "You assumed: SQLite",
  "A: Redis",
  "This differs from your assumption.",
  "",
].join("\n")
const LETTER_END = "These differ from your assumptions: revise the work that rests on q1 and q2, and say what you changed."

/** The frame's lines, without the sidebar's column. */
const lines = (frame: string): ReadonlyArray<string> => frame.split("\n").map((line) => line.slice(0, 108).trim())
/** The form's lines: the frame's from the form's title on, without its left border. */
const form = (frame: string): ReadonlyArray<string> => {
  const all = lines(frame).map((line) => line.replace(/^┃\s*/, ""))
  return all.slice(all.indexOf("Background questions")).filter((line) => line !== "")
}

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
    test(`asked ${via === "direct" ? "through ask_user_async" : "from a kernel cell"}: the tray, /answer's form, one letter per submit, a form closed unanswered`, async () => {
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
      expect(stdout).toMatch(/screenshot: .*questions-.*-form\.png/)

      // The root's tray counts its own three, from two asks, and its subagent's one, oldest first.
      expect(lines(read("tray.txt"))).toContain("? 4 open questions · Cache store, Old endpoint, Log format, Test runner · shift+← /answer")

      // /answer: the host's question form, a tab per question of the root's two asks, the assumed choice first.
      expect(form(read("form.txt")).slice(0, 8)).toEqual([
        "Background questions",
        "Cache store  Old endpoint  Log format  Submit",
        "Which database should the cache use?",
        "1. SQLite",
        "assumed · one file, no server",
        "2. Redis",
        "3. Type your own answer",
        "⇆ tab  ↑↓ select  enter confirm  esc dismiss",
      ])
      // Typed on the row under the assumption.
      expect(form(read("typed.txt")).slice(2, 6)).toEqual(["Should the old /v1 endpoint stay for a release?", "1. Keep it", "assumed", "2. Drop it after this release"])
      // The submit tab: two answered, the third left blank.
      expect(form(read("review.txt"))).toEqual(
        expect.arrayContaining(["Cache store: Redis", "Old endpoint: Drop it after this release", "Log format: (not answered)", "⇆ tab  enter submit  esc dismiss"]),
      )

      // One submit, one letter: the idle root wakes once on both answers; the blank one and the subagent's stay open.
      const answered = lines(read("answered.txt"))
      expect(answered.filter((line) => line.startsWith("◈ answered"))).toEqual([expect.stringMatching(/^◈ answered 2 · Which database should the cac… → Redis · /)])
      expect(answered).toContain("Root switched to Redis and dropped the endpoint")
      expect(answered).toContain("? 2 open questions · Log format, Test runner · shift+← /answer")
      // The same /answer opened the subagent's form, naming who asked.
      expect(form(read("answered.txt")).slice(0, 3)).toEqual(["Background questions", "Asked by general", "Which test runner should the suite use?"])

      // shift+← on the empty composer: the left-over question on its own; Enter on the assumption answers it, in a letter of its own.
      expect(form(read("again.txt")).slice(0, 3)).toEqual(["Background questions", "Should the logs be JSON?", "1. JSON"])
      expect(lines(read("subagent.txt"))).toContain("◈ answered · Should the logs be JSON? → JSON")
      // Esc closes the subagent's form; its question stays open and the prompt has the focus back.
      const done = lines(read("done.txt"))
      expect(done).toContain("? 1 open question · Test runner · assuming bun test · shift+← /answer")
      expect(done).toContain("┃ typed-after-answer")

      const requests: ReadonlyArray<Request> = JSON.parse(read("requests.json"))
      const root = requests.filter((request) => request.session === "root").map((request) => unescaped(request.request))
      // The tool answers at once with the ids and assumptions, and the root carries on.
      expect(root.some((request) => request.includes(RECEIPT))).toBe(true)
      const lettered = root.findIndex((request) => request.includes("Answers to your background questions q1 and q2:"))
      expect(lettered).toBeGreaterThan(0)
      expect(root[lettered]).toContain(LETTER)
      expect(root[lettered]).toContain("A: Drop it after this release\nThis differs from your assumption.")
      expect(root[lettered]).toContain(LETTER_END)
      expect(root.some((request) => request.includes("Answer to your background question q3") && request.includes("This is what you assumed: carry on."))).toBe(true)
      // The subagent never reads an answer.
      const asked = requests.filter((request) => request.session === "subagent").map((request) => unescaped(request.request))
      expect(asked.some((request) => request.includes("- q1: Which test runner should the suite use? · assuming bun test"))).toBe(true)
      expect(asked.some((request) => request.includes("background question"))).toBe(false)

      // Two submits, two synthetic messages in the root, their source `questions`; a kernel cell leaves no ask_user_async part.
      const sessions: ReadonlyArray<Session> = JSON.parse(read("transcripts.json"))
      const rootSession = sessions.find((session) => session.parentID === undefined || session.parentID === null)
      expect(rootSession?.messages.filter((message) => message.type === "synthetic" && message.metadata?.source === "questions")).toHaveLength(2)
      const tools = sessions.flatMap((session) =>
        session.messages.flatMap((message) => (Array.isArray(message.content) ? message.content.flatMap((part) => (part.type === "tool" && part.name !== undefined ? [part.name] : [])) : [])),
      )
      if (via === "kernel") expect(tools).not.toContain("ask_user_async")
      else expect(tools.filter((name) => name === "ask_user_async")).toHaveLength(3)
      console.log(`Questions (${via}) artifacts: ${out}`)
    }, 150_000)
})
