// accept: deep (9.7 s alone on a quiet host: 1-minute load 5.8 on 12 cores; it boots real OpenCode with both halves of Prime and memory, and streams the reply in small chunks)
// Runs scenarios/prime-emphasis.ts with both halves of Prime against an
// OpenCode checkout (SCENARIO_DUMP=1) and asserts on its requests and frames:
// the root's every request holds the reply-style section once, at the same
// place, before memory's digest; the worker's request holds none (and still
// gets the digest); the title's none; the finished frame draws the chips, and
// no streamed frame showed a closed pill as typed. The gate simulates who gets
// the section (cmd/prime/prime-rules.sim.test.ts) and the frame
// (cmd/prime/prime-emphasis.sim.test.tsx). It needs OPENCODE_DEV, the fork.
import { describe, expect, test } from "bun:test"
import { readScratchFileSync as readFileSync, scratchExistsSync } from "./read-path.ts"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-emphasis.test.ts: skipped. Set OPENCODE_DEV to the prime-look fork to run it.")

/** OpenCode's start, the streamed reply and a worker's turn: well past its usual 10 seconds. */
const SCENARIO_MS = 180_000

/** The scenario's record of each model request (scenarios/prime-emphasis.ts, SCENARIO_DUMP). */
const Requests = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ kind: Schema.Literals(["title", "root", "child"]), opens: Schema.Number, section: Schema.Number, digest: Schema.Number })),
)
const Stream = Schema.fromJsonString(Schema.Struct({ frames: Schema.Number, raw: Schema.Array(Schema.Unknown) }))

/** Runs the scenario and reads its requests, its finished frame and its stream record. */
const scenario = async (dir: string) => {
  const run = owned(["bunx", "opencode-drive", "run", "scenarios/prime-emphasis.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, SCENARIO_OUT: dir, SCENARIO_DUMP: "1", OPENCODE_DRIVE_MEDIA_DIR: join(dir, "media") },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = await new Response(run.stdout).text()
  const errors = await new Response(run.stderr).text()
  const code = await run.exited
  const dump = join(dir, "requests.json")
  expect({ code, ran: scratchExistsSync(dump) }, `${output}${errors}`.slice(-4000)).toEqual({ code: 0, ran: true })
  return {
    requests: Schema.decodeUnknownSync(Requests)(readFileSync(dump, "utf8")),
    frame: readFileSync(join(dir, "emphasis.txt"), "utf8"),
    stream: Schema.decodeUnknownSync(Stream)(readFileSync(join(dir, "emphasis-stream.json"), "utf8")),
  }
}

const CHIPS = [" ● Measured ", " ✓ Done 104/104 ", " ✗ Failed: 3 tests ", " ! Irreversible ", " $ Costs money ", "◆ Waiting on you:"]

describe.skipIf(!fork)("Prime teaches root sessions the chips and draws them (OPENCODE_DEV)", () => {
  const kept = keptScratch(Boolean(fork), "prime-emphasis-")

  test(
    "every root request holds the section once, at one place, before memory's digest; a worker's and a title's hold none; the reply draws its chips",
    kept.test(async () => {
      const { requests, frame, stream } = await scenario(kept.dir("prime-emphasis-"))

      const roots = requests.filter((request) => request.kind === "root")
      expect(roots.length).toBeGreaterThanOrEqual(3)
      for (const request of roots) {
        expect(request.opens).toBe(1)
        expect(request.digest).toBeGreaterThan(request.section)
      }
      expect(new Set(roots.map((request) => request.section)).size).toBe(1)

      const children = requests.filter((request) => request.kind === "child")
      expect(children.length).toBeGreaterThanOrEqual(1)
      for (const request of children) expect({ opens: request.opens, digest: request.digest > 0 }).toEqual({ opens: 0, digest: true })
      for (const request of requests.filter((request) => request.kind === "title")) expect(request.opens).toBe(0)

      for (const chip of CHIPS) expect(frame).toContain(chip)
      expect(frame).not.toContain("[[")
      expect(stream.raw).toEqual([])
    }),
    SCENARIO_MS,
  )
})
