// @reads all
// @reads-reason subprocess reads at tests/host-admit-terminal.test.ts: Effect.sync(() => spawn([...program], {
import { argv, readableStreamToText, spawn } from "bun"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Path, Predicate } from "effect"
import { expect, it } from "effect-bun-test"
import { hangGuard } from "./hang-guard.ts"
import { scratch } from "./scratch.ts"

const cli = Effect.fn("TerminalHarness.cli")(function* () {
  const path = yield* Path.Path
  const file = yield* path.fromFileUrl(new URL("./fixtures/host-admit-test-entry.ts", import.meta.url))
  const [exe = "bun"] = argv
  return [exe, file]
})

const invoke = Effect.fn("TerminalHarness.invoke")(function* (program: ReadonlyArray<string>, folder: string, limit = 16_000) {
  const task = yield* Effect.acquireRelease(
    Effect.sync(() => spawn([...program], {
      cwd: folder, env: { HOME: folder, XDG_STATE_HOME: folder, PATH: "/usr/bin:/bin" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true,
    })),
    (task) => Effect.sync(() => {
      if (Predicate.isNull(task.exitCode) && Predicate.isNull(task.signalCode)) task.kill("SIGTERM")
    }),
  )
  const [status, output, error] = yield* Effect.all([
    Effect.promise(() => task.exited),
    Effect.promise(() => readableStreamToText(task.stdout)),
    Effect.promise(() => readableStreamToText(task.stderr)),
  ], { concurrency: 3 }).pipe(Effect.timeout(limit))
  return { status, output, error }
})

it.scopedLive("standalone checks preserve their payload under pipes and under an ordinary nested terminal shell", () =>
  Effect.gen(function* () {
    if (process.platform !== "darwin") return
    using dir = scratch("hcl-terminal-")
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(`${dir.path}/host-admit-supply.json`, '{"outside":500}')
    const payload = [...(yield* cli()), "check", "run", "--", "/bin/sh", "-c", "printf 'payload-marker\\n'"]
    const plain = yield* invoke(payload, dir.path)
    expect(plain.status).toBe(0)
    expect(plain.output).toContain("payload-marker")
    const nested = yield* invoke([
      "/usr/bin/script", "-q", "/dev/null", "/bin/sh", "-c",
      '"$@"; printf "caller-back=%s\\n" "$?"', "fixture", ...payload,
    ], dir.path)
    expect(nested.status).toBe(0)
    expect(nested.output).toContain("payload-marker")
    expect(nested.output).toContain("caller-back=0")
  }).pipe(Effect.provide(BunServices.layer)),
  hangGuard("local-fixture"),
)

it.scopedLive("the foreground shell gets its tty back on stop and on Ctrl-C, and the resumed payload reads stdin", () =>
  Effect.gen(function* () {
    if (process.platform !== "darwin") return
    using dir = scratch("hcl-job-control-")
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(`${dir.path}/host-admit-supply.json`, '{"outside":500}')
    const path = yield* Path.Path
    const driver = yield* path.fromFileUrl(new URL("./fixtures/host-admit-pty.py", import.meta.url))
    const { status, output, error } = yield* invoke(["/usr/bin/python3", driver, dir.path, ...(yield* cli())], dir.path, 25_000)
    expect({ status, error }).toEqual({ status: 0, error: "" })
    expect(output).toContain("Ctrl-C exit and drain verified")
  }).pipe(Effect.provide(BunServices.layer)),
  hangGuard("local-pair"),
)
