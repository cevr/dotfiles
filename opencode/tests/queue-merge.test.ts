// accept: one at a time (its scenario drives a real TUI and waits on its frames under a deadline; the gate runs its Up, Escape and history names simulated, cmd/escape/queue-merge.sim.test.tsx, and only this file the deliver case, the escape server plugin's hook).
// Runs scenarios/queue-merge.ts once per case with the Prime look and the
// escape plugins (cmd/escape, TUI and server) against an OpenCode checkout,
// and asserts that waiting prompts act as one: three prompts queued behind a
// turn arrive as one user message, their texts on three lines; Up on the empty
// composer takes all three back into it, three lines, the queue empty and
// nothing sent; Escape does the same and stops the turn; and with nothing
// queued Up still walks the history. Needs OPENCODE_DEV, a fork with the
// experimental.queue.deliver hook and ui.composer.takeBack (its queue-merge branch).
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/queue-merge.test.ts: skipped. Set OPENCODE_DEV to the fork to run it.")

const ASK = "Rename the helper."
const QUEUED = ["Also update the docs.", "Then run the tests.", "Then tag it."]
/** How long one case gets: OpenCode's start and a few seconds of keys, well past its usual 20 seconds. */
const SCENARIO_MS = 150_000

/** The composer's rows: the last run of rail rows above the dock's rule. */
const composer = (frame: string) => {
  const lines = frame.split("\n")
  const rule = lines.findLastIndex((line) => /^ ─{10,}\s*$/.test(line))
  const above = lines.slice(0, Math.max(0, rule))
  const last = above.findLastIndex((line) => line.startsWith(" ┃"))
  const first = above.slice(0, last + 1).findLastIndex((line) => !line.startsWith(" ┃"))
  return above.slice(first + 1, last + 1)
}

/** Runs one case of the scenario and reads its frames and requests. */
const scenario = async (which: string, dir: string) => {
  const run = owned(["bunx", "opencode-drive", "run", "scenarios/queue-merge.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, CASE: which, SCENARIO_OUT: dir, OPENCODE_DRIVE_MEDIA_DIR: join(dir, "media") },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = await new Response(run.stdout).text()
  const errors = await new Response(run.stderr).text()
  const code = await run.exited
  const requests = join(dir, `${which}-requests.json`)
  expect({ code, ran: existsSync(requests) }, `${output}${errors}`.slice(-4000)).toEqual({ code: 0, ran: true })
  return {
    before: readFileSync(join(dir, `${which}-before.txt`), "utf8"),
    after: readFileSync(join(dir, `${which}-after.txt`), "utf8"),
    requests: JSON.parse(readFileSync(requests, "utf8")),
  }
}

const rows = (prompts: ReadonlyArray<string>) => prompts.map((prompt) => ` ┃ ${prompt}`)

describe.skipIf(!fork)("waiting prompts act as one (OPENCODE_DEV)", () => {
  const kept = keptScratch(Boolean(fork), "queue-merge-")

  test(
    "three prompts queued behind a turn arrive as one user message, joined by two newlines",
    kept.test(async () => {
      const shown = await scenario("deliver", kept.dir("queue-merge-deliver-"))
      for (const prompt of QUEUED) expect(shown.before).toContain(`◌ after the turn · ${prompt}`)
      expect(shown.requests).toEqual([[ASK, QUEUED.join("\n")]])
      // One message in the transcript: its three lines in one rail.
      expect(shown.after).toContain(rows(QUEUED).join("\n"))
      expect(shown.after).not.toContain("◌")
    }),
    SCENARIO_MS,
  )

  test(
    "Up on the empty composer takes the three queued prompts back as three lines; the queue empties and nothing is sent",
    kept.test(async () => {
      const shown = await scenario("up", kept.dir("queue-merge-up-"))
      for (const prompt of QUEUED) expect(shown.before).toContain(`◌ after the turn · ${prompt}`)
      expect(composer(shown.before)).toEqual([" ┃"])
      expect(composer(shown.after)).toEqual(rows(QUEUED))
      expect(shown.after).not.toContain("◌")
      // The turn they waited behind ran on and ended; no request carried a queued prompt.
      expect(shown.requests).toEqual([])
    }),
    SCENARIO_MS,
  )

  test(
    "Escape takes the three back the same way and stops the turn they waited behind",
    kept.test(async () => {
      const shown = await scenario("escape", kept.dir("queue-merge-escape-"))
      expect(composer(shown.after)).toEqual(rows(QUEUED))
      expect(shown.after).not.toContain("◌")
      expect(shown.after).toContain("■ Interrupted")
      expect(shown.requests).toEqual([])
    }),
    SCENARIO_MS,
  )

  test(
    "with nothing queued, Up on the empty composer still walks the history",
    kept.test(async () => {
      const shown = await scenario("history", kept.dir("queue-merge-history-"))
      expect(composer(shown.before)).toEqual([" ┃"])
      expect(composer(shown.after)).toEqual(rows([ASK]))
    }),
    SCENARIO_MS,
  )
})
