// Markup docs, provisioning text docs, and shell entry points the fixture inspects.
// @reads ../README.md ../**/*.{md,mdx,rst,org,adoc,markdown} **/*.{md,mdx,rst,org,adoc,markdown} ../**/*.sh **/*.sh ../workbox/bin/** ../workbox/**/*.txt ../linux/hetzner-workbox/**
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Stream } from "effect"
import { expect, it } from "effect-bun-test"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

// One bounded scanner invocation, with room for scheduling delays on the loaded gate; not a speed check.
const TEST_TIMEOUT = 30_000

const live = it.live.layer(BunServices.layer)
const run = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const child = yield* spawner.spawn(ChildProcess.make("python3", ["../linux/hetzner-workbox/test-guarded-docs.py", ...args], {
      stdin: "ignore",
      forceKillAfter: "3 seconds",
    }))
    const [output, code] = yield* Effect.all([child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode], { concurrency: 2 })
    return { output: output.trim(), code: Number(code) }
  }).pipe(Effect.scoped)

live("tracked documentation passes the script-derived host guard", () =>
  Effect.gen(function* () {
    const result = yield* run([])
    expect(result).toEqual({ code: 0, output: "guarded docs OK" })
  }),
  TEST_TIMEOUT,
)

live("the docs guard rejects new missing pins, broken handoffs and omitted peer pins", () =>
  Effect.gen(function* () {
    const result = yield* run(["--controls"])
    expect(result).toEqual({ code: 0, output: "guarded docs controls OK" })
  }),
  TEST_TIMEOUT,
)
