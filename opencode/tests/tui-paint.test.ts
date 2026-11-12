// Runs scenarios/tui-paint.ts against an OpenCode checkout and holds an idle
// orchestrator's TUI to at most 2 frames a second: the root idle with an alarm
// pending and three background workers running, in the owner's TUI (Prime and
// his other TUI plugins, animations on). Before this, the subagent rows'
// clock ticked 4 times a second and rebuilt every row on each tick, and the
// dock redrew on every 2-second wake reading: about 4.6 frames a second, each
// a full scene step. A TUI with nothing running paints next to nothing. It needs
// OPENCODE_DEV.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/tui-paint.test.ts: skipped. Set OPENCODE_DEV to an OpenCode checkout to run it.")

/** Frames a second an idle orchestrator's TUI may paint. */
const BUDGET = 2
/** Frames a second a TUI with nothing running may paint: none but a straggler of its start. */
const QUIET = 0.5
/** How long the scenario gets: two 10-second windows and OpenCode's start, well past its usual 40 seconds. */
const SCENARIO_MS = 200_000

describe.skipIf(!fork)("an idle orchestrator's TUI (OPENCODE_DEV)", () => {
  const kept = keptScratch(Boolean(fork), "tui-paint-")
  test(
    `paints next to nothing with nothing running, and at most ${BUDGET} frames a second with its workers running`,
    kept.test(async () => {
      const out = kept.dir("tui-paint-")
      const run = owned(["bunx", "opencode-drive", "run", "scenarios/tui-paint.ts"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const output = await new Response(run.stdout).text()
      const errors = await new Response(run.stderr).text()
      const code = await run.exited
      const paint = join(out, "paint.json")
      expect({ code, ran: existsSync(paint) }, `${output}${errors}`.slice(-4000)).toEqual({ code: 0, ran: true })
      const result = JSON.parse(readFileSync(paint, "utf8"))
      const shown = readFileSync(join(out, "orchestrator.txt"), "utf8")

      // The measured window is the idle orchestrator: three worker rows run and the dock counts the alarm.
      expect(shown.split("\n").filter((line) => /[◆◇] general .*Fix module \d/.test(line))).toHaveLength(3)
      expect(shown).toContain("1 wake")
      expect(result.orchestrator.seconds).toBeGreaterThan(9)
      // With nothing running it paints next to nothing (on a loaded host a late frame of its start may land in the window);
      // with its workers running, at most BUDGET frames a second, and nothing holds the loop live.
      expect(result.quiet.loops).toBeLessThan(QUIET)
      expect(result.orchestrator.loops).toBeLessThanOrEqual(BUDGET)
      expect(result.orchestrator.live).toBe(0)
    }),
    SCENARIO_MS,
  )
})
