// accept: deep (11.2 s alone on a quiet host: 1-minute load 4.2–6.4 on 12 cores; it boots real OpenCode and a second, real TUI in a pty, and drives a turn through events that take that long)
// Real OpenCode, the Rex mod's TUI plugin (cmd/rex), a scripted model and a
// real terminal: scenarios/rex-state.ts types one turn with a shell call into
// a real TUI in a pty that believes it runs in a Rex pane, reads the OSC 7501
// program status reports out of the bytes the TUI wrote, stops the TUI with
// SIGTERM and prints every report, which this test reads: the session goes
// to work with the command as its message, goes idle under its title, and the
// record is cleared on exit, last; the host's per-session records never show.
// Needs OPENCODE_DEV, a fork with ui.programStatus.claim.
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/rex-state.test.ts: skipped. Set OPENCODE_DEV to the fork.")

const Heard = Schema.fromJsonString(Schema.Array(Schema.Record(Schema.String, Schema.String)))
const HEARD = /^rex heard: (.*)$/m
/** How long the run gets: OpenCode's start and a few seconds of turn, well past its usual 11 seconds. */
const SCENARIO_MS = 150_000

describe.skipIf(!fork)("OpenCode's state in a Rex pane's program status (OPENCODE_DEV)", () => {
  const kept = keptScratch(Boolean(fork), "rex-state-")

  test(
    "a turn that runs a shell command reports working with the command, then idle, and clears the record on exit",
    kept.test(async () => {
      const dir = kept.dir("rex-state-")
      const run = owned(["bunx", "opencode-drive", "run", "scenarios/rex-state.ts"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, OPENCODE_DRIVE_MEDIA_DIR: join(dir, "media"), REX_STATE_LOG: join(dir, "terminal.log") },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const output = await new Response(run.stdout).text()
      const errors = await new Response(run.stderr).text()
      const code = await run.exited
      const log = HEARD.exec(output)?.[1] ?? "[]"
      expect({ code }, `${output}${errors}`.slice(-5000)).toEqual({ code: 0 })
      // The renderer's capability query (`OSC 7501 ; ?`) is no report.
      const heard = Schema.decodeUnknownSync(Heard)(log).filter((report) => !("?" in report))

      // The root record only: the host's per-session records never show, and every report but the clears names OpenCode.
      expect(heard.filter((report) => "id" in report), log).toEqual([])
      for (const report of heard.filter((entry) => entry.state !== "clear")) expect(report.app, log).toBe("opencode")

      const states = heard.map((report) => report.state)
      const working = heard.findIndex((report) => report.state === "working" && report.msg === "shell: sleep 2 && echo checked")
      expect(working, log).toBeGreaterThanOrEqual(0)
      const idle = states.indexOf("idle", working)
      expect(idle, log).toBeGreaterThan(working)
      expect(heard[idle]?.title, log).toBe("rex check")
      // Exit clears, and nothing is written after the last clear.
      expect(states.at(-1), log).toBe("clear")
    }),
    SCENARIO_MS,
  )
})
