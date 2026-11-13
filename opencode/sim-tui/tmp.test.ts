// The simulated TUI leaves nothing in the temp directory, however its file
// ends: a sim file, green and red, run as a child `bun test` with TMPDIR at a
// fresh folder, leaves that folder empty. The harness's folders (the clock's
// read, the host dirs it points our plugins at) and the fork fixture's own are
// removed when the file ends.
import { expect } from "bun:test"
import { Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { platformTest } from "./effect-test.ts"

const RUN_MS = 120_000
const CASES = [
  { fixture: "./sim-tui/fixtures/host.fixture.tsx", ends: /^ 3 pass\n 0 fail$/m },
  { fixture: "./sim-tui/fixtures/tmp-fail.fixture.tsx", ends: /^ 2 pass\n 1 fail$/m },
]

/** A child's whole output, as text. */
const text = (stream: Stream.Stream<Uint8Array, unknown>) => stream.pipe(Stream.decodeText(), Stream.mkString)

for (const { fixture, ends } of CASES)
  platformTest(
    `${fixture} leaves its temp directory as it found it`,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const root = path.dirname(yield* path.fromFileUrl(new URL(".", import.meta.url)))
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "sim-tui-tmp-guard-" })
      const child = yield* spawner.spawn(
        ChildProcess.make(process.execPath, ["test", "--timeout", String(RUN_MS), fixture], {
          cwd: root,
          env: { TMPDIR: tmp },
          extendEnv: true,
          stdin: "ignore",
          forceKillAfter: "3 seconds",
        }),
      )
      const [stdout, stderr] = yield* Effect.all([text(child.stdout), text(child.stderr)], { concurrency: 2 })
      yield* child.exitCode
      expect(`${stdout}\n${stderr}`).toMatch(ends)
      expect(yield* fs.readDirectory(tmp)).toEqual([])
    }),
    RUN_MS,
  )
