// Runs scenarios/prime-fallback.ts with the Prime look, the orchestrate and
// wakes plugins, a stand-in pool and a stand-in Codex provider against an
// OpenCode checkout: a planner (Codex plans and verifies, never implements) the pool holds on its first model starts at
// once on the newest Codex sol, which the admission script admits, instead
// of latching. The call log says it fell back and why, the pool counts it on
// the Codex provider, the worker's request goes to sol, and the parent reads
// where it ran and why first in the call's result (OpenCode runs every
// subagent in the background), then the answer. It needs OPENCODE_DEV, the fork
// with the plugin hook points the Prime rows use.
import { beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/prime-fallback.test.ts: skipped. Set OPENCODE_DEV to the prime-look fork to run it.")

const root = join(import.meta.dir, "..")
let frame: ReadonlyArray<string> = []
let calls: ReadonlyArray<Record<string, unknown>> = []
let paces: ReadonlyArray<Record<string, unknown>> = []
let admits: ReadonlyArray<ReadonlyArray<string>> = []
let requests = { worker: "", parent: "" }

const jsonl = <A = Record<string, unknown>>(path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as A)

const NOTE = "orchestrate: this agent runs on codex/gpt-6.1-sol#high, the Codex fallback (simulation/gpt-sim-model#medium held: scripted 5h window is full)."

describe.skipIf(!fork)("a held subagent falls back to Codex (OPENCODE_DEV)", () => {
  const kept = keptScratch(Boolean(fork), "prime-fallback-")
  beforeAll(...kept.setup(async () => {
    const out = kept.dir("prime-fallback-")
    const run = owned(["bunx", "opencode-drive", "run", "scenarios/prime-fallback.ts"], {
      cwd: root,
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()])
    if (code !== 0) throw new Error(`the scenario exited ${code}:\n${(stdout + stderr).slice(-4000)}`)
    frame = readFileSync(join(out, "fallback-done.txt"), "utf8").split("\n")
    calls = jsonl(join(out, "agents.jsonl"))
    paces = jsonl(join(out, "pace.jsonl"))
    admits = jsonl<ReadonlyArray<string>>(join(out, "admit.jsonl"))
    requests = JSON.parse(readFileSync(join(out, "fallback-requests.json"), "utf8")) as typeof requests
  }, 300_000))

  test("the pool holds the first model, and the admission script is asked about the newest sol for the role", kept.test(() => {
    expect(paces.map((line) => (line.started === true ? `started ${line.providerID}` : `${line.ok === true ? "ok" : "held"} ${line.providerID}`))).toEqual([
      "held simulation",
      "started codex",
    ])
    expect(admits).toEqual([["--codex", "--admit", "--model", "gpt-6.1-sol", "--role", "planner"]])
  }))

  test("it starts at once on sol, never latched, and the call log says why", kept.test(() => {
    expect(calls.map((line) => line.kind)).toEqual(["call", "done"])
    expect(calls[0]).toMatchObject({
      agent: "planner",
      model: "codex/gpt-6.1-sol#high",
      fallback: "simulation/gpt-sim-model#medium held: scripted 5h window is full",
    })
    // OpenCode runs every subagent in the background: the call ends as the worker starts.
    expect(calls[1]).toMatchObject({ status: "running" })
  }))

  test("the worker's request goes to sol", kept.test(() => {
    expect(requests.worker).toContain('"model":"gpt-6.1-sol"')
  }))

  test("the parent reads where it ran and why, first in the call's result, then the answer, and its row shows sol", kept.test(() => {
    expect(requests.parent).toContain(JSON.stringify(`${NOTE}\nThe subagent is working in the background`).slice(1, -1))
    expect(requests.parent).toContain(JSON.stringify(`state="completed" description="Check the export">\nThe export check passed.`).slice(1, -1))
    expect(frame.join("\n")).toContain("Root heard: the export check passed.")
    expect(frame.map((line) => line.trim())).toContainEqual(expect.stringMatching(/^◆ planner sol 6\.1  Check the export  /))
  }))
})
