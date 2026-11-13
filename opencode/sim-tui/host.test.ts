// The simulated TUI never reads the host it runs on. A fake host (a scratch
// HOME and XDG_STATE_HOME, given to a child `bun test` through its env) holds
// the upstream reading `bun run daily` writes, 38 commits behind with the merge
// blocked; the harness points every dir our plugins read into its own scratch
// (decider/tui-dirs.ts), so the child's frame at rest shows no `upstream +`.
// Before the seam, Prime read the reading from the process's own env and drew
// it in the composer's footer.
import { expect } from "bun:test"
import { Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { platformTest } from "./effect-test.ts"

const FIXTURE = "./sim-tui/fixtures/host.fixture.tsx"
const RUN_MS = 120_000
const READING = `{"commits":38,"blocked":true,"upstream":"abc1234","build":"def5678","at":"2026-11-13T09:00:00Z"}`

/** A child's whole output, as text. */
const text = (stream: Stream.Stream<Uint8Array, unknown>) => stream.pipe(Stream.decodeText(), Stream.mkString)

platformTest(
  "a reading on the host the test runs on never reaches a frame",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const root = path.dirname(yield* path.fromFileUrl(new URL(".", import.meta.url)))
    const host = yield* fs.makeTempDirectoryScoped({ prefix: "sim-tui-fake-host-" })
    const env = { HOME: path.join(host, "home"), XDG_STATE_HOME: path.join(host, "state") }
    // The reading where daily writes it: under XDG_STATE_HOME, and under HOME's own state dir.
    for (const state of [env.XDG_STATE_HOME, path.join(env.HOME, ".local/state")]) {
      yield* fs.makeDirectory(path.join(state, "opencode-daily"), { recursive: true })
      yield* fs.writeFileString(path.join(state, "opencode-daily/upstream.json"), READING)
    }
    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, ["test", "--timeout", String(RUN_MS), FIXTURE], {
        cwd: root,
        env,
        extendEnv: true,
        stdin: "ignore",
        forceKillAfter: "3 seconds",
      }),
    )
    const [stdout, stderr] = yield* Effect.all([text(child.stdout), text(child.stderr)], { concurrency: 2 })
    yield* child.exitCode
    const said = `${stdout}\n${stderr}`
    const frame = said.split("\n").filter((line) => line.startsWith("host-frame| "))
    expect(frame.length).toBeGreaterThan(0)
    expect(frame.filter((line) => line.includes("upstream +"))).toEqual([])
    expect(said).toMatch(/^ 3 pass\n 0 fail$/m)
  }),
  RUN_MS,
)
