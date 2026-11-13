// Isolation of the seeds that share one app: a seed run alone (`SIM_SEED=<n>`,
// its file booting a fresh app for it) gives the same trace as that seed in
// the file's full run, after every seed before it, for seeds 2 to 4 of each
// simulated TUI file. A seed that left something behind in the app (a
// toast, a session still running, a timer's phase, a draft) shows here as a
// trace that depends on what ran before it.
//
// Each run is a `bun test` of its own, in a process group of its own, killed
// if it outlives RUN_MS.
import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { TRACE_ENV } from "./app.ts"

const ROOT = path.resolve(import.meta.dir, "..")
const FILES = ["cmd/prime/prime-escape.sim.test.tsx", "cmd/prime/prime-sidebar.sim.test.tsx", "cmd/escape/escape-states.sim.test.tsx"]
// Seed 1 is the first after the boot in both runs; the seeds after it are the ones a seed before could reach.
const ALONE = [2, 3, 4]
const RUN_MS = 300_000

/** Runs `file` with `env` added, writing its seeds' traces to a new folder; returns the folder. */
const run = (file: string, env: Record<string, string>) =>
  new Promise<string>((resolve, reject) => {
    const traces = mkdtempSync(path.join(tmpdir(), "sim-tui-isolation-"))
    const child = spawn("bun", ["test", "--timeout", String(RUN_MS), `./${file}`], {
      cwd: ROOT,
      env: { ...process.env, ...env, [TRACE_ENV]: traces },
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
      // A run that outlives its limit is killed (it starts no process of its own: the TUI runs in it).
      timeout: RUN_MS,
      killSignal: "SIGKILL",
    })
    const errors: Array<string> = []
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk.toString()))
    child.on("exit", (code) => {
      if (code === 0) resolve(traces)
      else reject(new Error(`${file} ${JSON.stringify(env)} exited ${code}:\n${errors.join("").slice(-2_000)}`))
    })
  })

const read = (dir: string) => new Map(readdirSync(dir).map((name) => [name, readFileSync(path.join(dir, name), "utf8")]))

for (const file of FILES)
  test(
    `${file}: seeds ${ALONE.join(", ")} alone give the traces they give in the full run`,
    async () => {
      const folders: Array<string> = []
      try {
        const full = await run(file, {})
        folders.push(full)
        const everyone = read(full)
        for (const seed of ALONE) {
          const alone = await run(file, { SIM_SEED: String(seed) })
          folders.push(alone)
          const traces = read(alone)
          expect(traces.size).toBeGreaterThan(0)
          for (const [name, trace] of traces) expect({ name, trace }).toEqual({ name, trace: everyone.get(name) ?? "(not in the full run)" })
        }
      } finally {
        for (const folder of folders) rmSync(folder, { recursive: true, force: true })
      }
    },
    RUN_MS * (ALONE.length + 1),
  )
