// Real OpenCode, the real herdr reporter (cmd/herdr), a scripted model and a
// fake herdr socket: scenarios/herdr.ts runs one turn with a shell call while
// the TUI believes it runs in herdr pane wtest:p1, and herdr hears the session
// go to work, what runs, and go idle again.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Received } from "../mods/herdr/laws.ts"
import { listen } from "../mods/herdr/herdr/fake-server.ts"
import { owned } from "./owned.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/herdr.test.ts: skipped. Set OPENCODE_DEV to the fork.")

const field = (request: Received, key: string): unknown =>
  typeof request.params === "object" && request.params !== null ? Reflect.get(request.params, key) : undefined

describe.skipIf(!fork)("the herdr reporter in a real TUI", () => {
  test("a turn that runs a shell command reports working, with the command as its label, then idle, and releases the pane on exit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-"))
    const server = listen(join(dir, "herdr.sock"))
    if ("failed" in server) throw new Error(`the fake herdr could not listen: ${server.failed}`)
    try {
      const child = owned(["bunx", "opencode-drive", "run", "scenarios/herdr.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, HERDR_FAKE_SOCKET: server.path, OPENCODE_DRIVE_MEDIA_DIR: join(dir, "media") },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      if (code !== 0) throw new Error(`the herdr scenario exited ${code}:\n${(stdout + stderr).slice(-5000)}`)
      const log = JSON.stringify(server.received(), null, 1)
      const bySeq = new Map<string, Received>()
      for (const request of server.received()) {
        const seq = String(field(request, "seq"))
        if (bySeq.has(seq)) expect(bySeq.get(seq), `a seq sent twice is a retry of one request:\n${log}`).toEqual(request)
        else bySeq.set(seq, request)
      }
      const received: ReadonlyArray<Received> = [...bySeq.values()]

      // Every request (a retry, sent as it was when herdr answers late, counts once) names our pane, our source and our agent, and counts upward.
      for (const request of received) {
        expect(field(request, "pane_id")).toBe("wtest:p1")
        expect(field(request, "source")).toBe("dotfiles:opencode")
        expect(field(request, "agent")).toBe("opencode")
      }
      const seqs = received.map((request) => Number(field(request, "seq")))
      expect(seqs, log).toEqual([...seqs].sort((a, b) => a - b))

      const states = received.filter((request) => request.method === "pane.report_agent")
      const working = states.findIndex((request) => field(request, "state") === "working")
      expect(working, log).toBeGreaterThanOrEqual(0)
      const idle = states.findIndex((request, at) => at > working && field(request, "state") === "idle")
      expect(idle, log).toBeGreaterThan(working)
      const session = field(states[working] ?? { method: "", params: {} }, "agent_session_id")
      expect(session).toEqual(expect.stringMatching(/^ses_/))
      expect(field(states[working] ?? { method: "", params: {} }, "resume_argv")).toEqual(["opencode", "-s", session])
      expect(field(states[idle] ?? { method: "", params: {} }, "agent_session_id")).toBe(session)

      const metadata = received.filter((request) => request.method === "pane.report_metadata")
      const labels = metadata.map((request) => field(request, "state_labels"))
      expect(labels, log).toContainEqual({ working: "shell: sleep 2 && echo checked" })
      const titles = metadata.map((request) => field(request, "title"))
      expect(titles, log).toContain("herdr check")

      // Closing the TUI releases the pane.
      expect(received.at(-1)?.method, log).toBe("pane.release_agent")
    } finally {
      server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 150_000)
})
