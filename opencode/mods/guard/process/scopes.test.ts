// Scopes: none off Linux; on Linux, the probe's exit decides, a probe that
// cannot start is none, and it is asked once. The probes here are `true`,
// `false` and a missing program, never systemd itself.
import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Scopes } from "../service.ts"
import * as ProcessScopes from "./scopes.ts"

const ask = (platform: string, probe: ReadonlyArray<string>, times = 1) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const scopes = yield* Scopes
      const answers: Array<boolean> = []
      for (let index = 0; index < times; index += 1) answers.push(yield* scopes.available)
      return answers
    }).pipe(Effect.provide(ProcessScopes.layer(platform, probe))),
  )

test("there is no scope off Linux, whatever the probe says", async () => {
  expect(await ask("darwin", ["true"])).toEqual([false])
})

test("on Linux the probe's exit decides, and a probe that cannot start means none", async () => {
  expect(await ask("linux", ["true"])).toEqual([true])
  expect(await ask("linux", ["false"])).toEqual([false])
  expect(await ask("linux", ["/nonexistent/scope-probe-x"])).toEqual([false])
})

test("the probe runs once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-scopes-"))
  const log = join(dir, "probes")
  expect(await ask("linux", ["/bin/sh", "-c", `echo probe >> '${log}'`], 3)).toEqual([true, true, true])
  expect(readFileSync(log, "utf8")).toBe("probe\n")
  rmSync(dir, { recursive: true, force: true })
})
