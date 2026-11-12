// Public seam: real OpenCode with `experimental.schedules` on, the real wake
// server plugin, the built-in schedule plugin off as daily writes it, and a
// scripted model. scenarios/wake-repeat.ts asks the model once (keeping the
// tools it was offered), sets a `repeat: "change"` monitor on a status file,
// changes the file twice and cancels the monitor. The schedule tools must be
// gone from the request while the flag is on, the `/schedule` command from
// the server's commands, and each change must reach the
// session as one short synthetic notice, never a user prompt.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { owned } from "./owned.ts"
import { scratch } from "./scratch.ts"

interface Request {
  readonly session?: "root" | "title"
  readonly request: string
}
interface Message {
  readonly type?: string
  readonly text?: string
  readonly metadata?: { readonly source?: string; readonly kind?: string; readonly outcome?: string; readonly repeat?: string; readonly fires?: number }
}
interface Session {
  readonly id: string
  readonly messages: ReadonlyArray<Message>
}

const label = "wake-repeat"
const run = async (out: string) => {
  const child = owned(["bunx", "opencode-drive", "run", "scenarios/wake-repeat.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  const timeout = join(out, `${label}-timeout.txt`)
  if (code !== 0) throw new Error(`${label} scenario exited ${code}:\n${(stdout + stderr).slice(-5000)}\n${existsSync(timeout) ? readFileSync(timeout, "utf8") : ""}`)
  return { read: (name: string) => readFileSync(join(out, `${label}-${name}`), "utf8") }
}

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/wake-repeat.test.ts: skipped. Set OPENCODE_DEV to the fork.")
describe.skipIf(!fork)("with OpenCode's schedules on", () => {
  test("the schedule tools are gone, and a repeating monitor wakes the session once per change with a short notice", async () => {
    using out = scratch(`${label}-`)
    const { read } = await run(out.path)
    const requests: ReadonlyArray<Request> = JSON.parse(read("requests.json"))
    const root = requests.filter((request) => request.session === "root")

    // The flag is on, yet with the built-in schedule plugin off neither its /schedule command nor a schedule tool is offered; ours are.
    const commands: ReadonlyArray<string> = JSON.parse(read("commands.json"))
    expect(commands).toContain("review")
    expect(commands).not.toContain("schedule")
    expect(root.length).toBeGreaterThan(0)
    for (const request of root) {
      expect(request.request).not.toMatch(/schedule_(create|list|pause|resume|delete)/)
      expect(request.request).toContain("wake_cancel")
    }

    // The baseline fired nothing; each change woke the idle session once, and the unchanged output never again.
    expect(read("set.txt")).not.toContain("Saw fire")
    expect(read("first.txt")).toContain("Saw fire 1.")
    expect(read("second.txt")).toContain("Saw fire 2.")
    expect(read("second.txt")).not.toContain("Saw fire 3.")
    expect(read("stopped.txt")).toContain("Watch stopped.")

    const sessions: ReadonlyArray<Session> = JSON.parse(read("transcripts.json"))
    const messages = sessions.flatMap((session) => session.messages)
    const fired = messages.filter((message) => message.metadata?.source === "wake")
    expect(fired.map((message) => [message.type, message.metadata?.kind, message.metadata?.outcome, message.metadata?.repeat, message.metadata?.fires])).toEqual([
      ["synthetic", "monitor", "matched", "change", 1],
      ["synthetic", "monitor", "matched", "change", 2],
    ])
    expect(fired[0]?.text).toContain("Note: WATCH: the status changed\nOutput (exit 0):\nstatus two")
    expect(fired[1]?.text).toContain("Output (exit 0):\nstatus three")
    for (const message of fired) expect((message.text ?? "").length).toBeLessThan(600)
    // No user message carries the note: the only user prompts are the three steps typed.
    expect(messages.filter((message) => message.type === "user" && (message.text ?? "").includes("WATCH"))).toEqual([])
  }, 180_000)
})
