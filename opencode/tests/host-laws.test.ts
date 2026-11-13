// The host laws (sim/host-laws.ts) in real OpenCode: one boot of the fork
// through its SDK (sim/real.ts) in a scratch home, on a scripted model, with
// the law probe (sim/server.ts) loaded from config. Each law is one test,
// under the name it has on the world (sim/host-laws.test.ts): what the world
// does for a plugin, real OpenCode does too.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { Option, Schema } from "effect"
import { KEPT, NAMES, outcome } from "../sim/law-names.ts"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env["OPENCODE_DEV"] ?? ""
const runs = fork !== ""
if (!runs) console.warn("tests/host-laws.test.ts: the OpenCode run skips. Set OPENCODE_DEV to the fork.")

/** opencode/: the tests run from it. */
const ROOT = process.cwd()
const kept = keptScratch(runs, "host-laws-e2e-")
const Result = Schema.fromJsonString(Schema.Struct({ lines: Schema.Array(Schema.String) }))

/** The probe's outcome lines from one real boot; a failed run is one line that says how it failed. */
const boot = async (): Promise<ReadonlyArray<string>> => {
  const base = kept.dir("run-")
  const home = join(base, "home")
  mkdirSync(home)
  const child = owned([process.execPath, join(ROOT, "sim/real.ts"), base, resolve(fork), join(ROOT, "sim")], {
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      OPENCODE_DISABLE_MODELS_FETCH: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 360_000)
  // Both pipes read at once, so neither fills while the other is read.
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  await child.exited
  clearTimeout(timer)
  const result = join(base, "result.json")
  if (child.exitCode !== 0 || !existsSync(result)) return [`the real run failed (exit ${child.exitCode}):\n${await stdout}\n${await stderr}`]
  return Schema.decodeUnknownSync(Result)(readFileSync(result, "utf8")).lines
}

/** The one boot, shared by every law's test. */
const shared = { boot: Option.none<Promise<ReadonlyArray<string>>>() }
const lines = () => {
  return Option.getOrElse(shared.boot, () => {
    const started = boot()
    shared.boot = Option.some(started)
    return started
  })
}

describe.skipIf(!runs)("the host laws in real OpenCode", () => {
  for (const name of NAMES)
    test(
      name,
      kept.test(async () => {
        expect(outcome(await lines(), name)).toEqual([`${KEPT}${name}`])
      }),
      400_000,
    )
})
