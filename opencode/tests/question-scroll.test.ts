// Public UI seam: real OpenCode at a phone's size (45 columns by 25 rows), a
// scripted model that asks a question of sixty lines through the built-in
// `question` tool, or through `ask_user_async` answered from /answer's form.
// The form opens on the question's first line with its keys on screen; the
// wheel moves it; PageDown pages it to its last line and its options; the
// second option, picked with ↓ and Enter, reaches the session's model.
// scenarios/question-scroll.ts drives it; the frames are read here.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { owned } from "./owned.ts"

/** The frame's lines, trimmed, without the form's left border or its scrollbar's column. */
const lines = (frame: string): ReadonlyArray<string> =>
  frame.split("\n").map((line) => line.replace(/^\s*┃\s*/, "").replace(/\s+[█▀▄]$/, "").trim())

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/question-scroll.test.ts: skipped. Set OPENCODE_DEV to the fork.")
describe.skipIf(!fork)("a question taller than a phone's pane", () => {
  for (const via of ["builtin", "async"] as const)
    test(`asked ${via === "builtin" ? "through the question tool" : "through ask_user_async, answered from /answer"}: it scrolls from its first line to its options, and the pick reaches the session`, async () => {
      const out = mkdtempSync(join(tmpdir(), `question-scroll-${via}-`))
      const child = owned(["bunx", "opencode-drive", "run", "scenarios/question-scroll.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, SCENARIO_OUT: out, QUESTION_VIA: via, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      const read = (name: string) => readFileSync(join(out, `question-scroll-${via}-${name}.txt`), "utf8")
      const timeout = join(out, `question-scroll-${via}-timeout.txt`)
      if (code !== 0) throw new Error(`question-scroll scenario (${via}) exited ${code}:\n${(stdout + stderr).slice(-5000)}\n${existsSync(timeout) ? readFileSync(timeout, "utf8") : ""}`)

      // The form opens on its title and the question's first line, the keys under it on screen and the page key offered.
      const start = lines(read("start"))
      expect(start).toContain(via === "async" ? "Background questions" : "Questions")
      expect(start).toContain("line 1 of the question")
      expect(start).not.toContain("line 60 of the question")
      expect(start).toContain("↑↓ select  pgdn scroll  enter submit")
      if (via === "async") expect(start).toContain("? 1 open question · shift+← /answer")

      // The wheel moves it off its first line.
      expect(lines(read("wheel"))).not.toContain("line 1 of the question")

      // Paged to the end: the last line, every option and the custom answer, the keys still under them.
      const end = lines(read("end"))
      // A background question marks its assumed option in the label; the question tool has no assumption.
      const first = via === "async" ? "1. Keep it (assumed)" : "1. Keep it"
      expect(end).toEqual(expect.arrayContaining(["line 60 of the question", first, "2. Drop it", "3. Type your own answer", "↑↓ select  pgdn scroll  enter submit"]))
      expect(end.indexOf("line 60 of the question")).toBeLessThan(end.indexOf(first))

      // ↓ and Enter picked the second option, and the model read it.
      expect(lines(read("done"))).toContain("Root read Drop it")
    }, 300_000)
})
