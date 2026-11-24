// Markup docs, provisioning text docs, and shell entry points the fixture inspects.
// @reads ../README.md ../**/*.{md,mdx,rst,org,adoc,markdown} **/*.{md,mdx,rst,org,adoc,markdown} ../**/*.sh **/*.sh ../workbox/bin/** ../workbox/**/*.txt ../linux/hetzner-workbox/**
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Stream } from "effect"
import { expect, it } from "effect-bun-test"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { hangGuard } from "../tests/hang-guard.ts"

const run = (script: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const child = yield* spawner.spawn(ChildProcess.make("python3", [`../linux/hetzner-workbox/${script}`, ...args], {
      stdin: "ignore",
      forceKillAfter: "3 seconds",
    }))
    const [output, code] = yield* Effect.all([child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode], { concurrency: 2 })
    return { output: output.trim(), code: Number(code) }
  }).pipe(Effect.scoped)

const scan = (args: ReadonlyArray<string>) => run("test-guarded-docs.py", args)

it.live.layer(BunServices.layer)("tracked documentation passes the script-derived host guard", () =>
  Effect.gen(function* () {
    const result = yield* scan([])
    expect(result).toEqual({ code: 0, output: "guarded docs OK" })
  }),
  hangGuard("local-fixture"),
)

it.live.layer(BunServices.layer)("the docs guard rejects new missing pins, broken handoffs and omitted peer pins", () =>
  Effect.gen(function* () {
    const result = yield* scan(["--controls"])
    expect(result).toEqual({ code: 0, output: "guarded docs controls OK" })
  }),
  hangGuard("local-fixture"),
)

it.live.layer(BunServices.layer)("the scanner preserves main's exact verdict bytes with canonical and aliased TMPDIRs", () =>
  Effect.gen(function* () {
    const result = yield* run("test-guarded-docs-parity.py", [])
    expect(result).toEqual({
      code: 0,
      output: "guarded docs byte parity OK (tracked scan and 15 control invocations across both TMPDIR spellings)",
    })
  }),
  hangGuard("process-fixture"),
)
