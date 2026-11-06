// Public tool seam: real OpenCode, the real wake server plugin with its
// process runner, Prime and a scripted model. scenarios/job.ts runs a job whose
// end wakes the idle session, and a job it kills. What happened is read off
// the model's requests, the transcripts and the frames.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

interface Request {
  readonly session?: "root" | "title"
  readonly request: string
}
interface Message {
  readonly type?: string
  readonly text?: string
  readonly metadata?: { readonly source?: string; readonly kind?: string; readonly progress?: boolean; readonly exitCode?: number | null }
}
interface Session {
  readonly messages: ReadonlyArray<Message>
}

const unescaped = (request: string) => request.replaceAll("\\n", "\n").replaceAll('\\"', '"')
const lines = (frame: string): ReadonlyArray<string> => frame.split("\n").map((line) => line.slice(0, 108).trim())

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/job.test.ts: skipped. Set OPENCODE_DEV to the fork.")
describe.skipIf(!fork)("jobs", () => {
  test("a job's end steers a letter with its exit, log tail and note into the idle session; a killed job wakes nobody", async () => {
    const out = mkdtempSync(join(tmpdir(), "job-"))
    const child = Bun.spawn(["bunx", "opencode-drive", "run", "scenarios/job.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    const timeout = join(out, "job-timeout.txt")
    if (code !== 0) throw new Error(`job scenario exited ${code}:\n${(stdout + stderr).slice(-5000)}\n${existsSync(timeout) ? readFileSync(timeout, "utf8") : ""}`)
    const read = (name: string) => readFileSync(join(out, `job-${name}`), "utf8")

    const root = (JSON.parse(read("requests.json")) as ReadonlyArray<Request>).filter((request) => request.session === "root").map((request) => unescaped(request.request))
    // The receipt: the id, the log, and that the end letter will come.
    const receipt = root.find((text) => text.includes("call_job_kappa") && /Job j[0-9a-z]{6} started\. Log: /.test(text)) ?? ""
    expect(receipt).toContain("in its own process group")
    expect(receipt).toContain("$JOB_DRIP")
    // The letter: the exit, the log tail, the note, and the progress line.
    const letter = root.find((text) => text.includes("Note: KAPPA")) ?? ""
    expect(letter).toMatch(/⏰ Job j[0-9a-z]{6} exited 4 after \d+s: `echo kappa-start/)
    expect(letter).toContain("Note: KAPPA: read the result")
    expect(letter).toContain("kappa-start\nKAPPA-DONE")
    expect(letter).toContain("compiled")
    expect(lines(read("kappa.txt"))).toContain("Woke on kappa.")

    // The kill: answered killed, and no letter came.
    expect(lines(read("killed.txt"))).toContain("Lambda killed.")
    expect(root.some((text) => /⏰ Job j[0-9a-z]{6} [^\n]*`sleep 300`/.test(text))).toBe(false)

    const sessions: ReadonlyArray<Session> = JSON.parse(read("transcripts.json"))
    const letters = sessions.flatMap((session) => session.messages.filter((message) => message.type === "synthetic" && message.metadata?.kind === "job" && message.metadata.progress !== true))
    expect(letters.map((message) => message.metadata?.exitCode)).toEqual([4])
    console.log(`Job artifacts: ${out}`)
  }, 240_000)
})
