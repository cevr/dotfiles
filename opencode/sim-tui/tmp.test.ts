// @reads all
// @reads-reason subprocess reads at sim-tui/tmp.test.ts: ChildProcess.make(process.execPath, ["test", "--timeout", String(RUN_MS), ...fixtures], {
// The simulated TUI leaves nothing in the temp directory, however its file
// ends: a sim file, green and red, run as a child `bun test` with TMPDIR at a
// fresh folder, leaves that folder empty. The harness's folders (the clock's
// read, the host dirs it points our plugins at) and the fork fixture's own are
// removed when the file ends. Two files in one `bun test` share one process
// and the fork preload's scratch home, which the first file's end removes:
// the second still boots and runs (scratch-home.ts).
import { expect } from "bun:test"
import { Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { platformTest } from "./effect-test.ts"
import { hangGuard } from "../tests/hang-guard.ts"

const RUN_MS = 120_000
const CASES = [
  { fixtures: ["./sim-tui/fixtures/host.fixture.tsx"], ends: /^ 3 pass\n 0 fail$/m },
  { fixtures: ["./sim-tui/fixtures/tmp-fail.fixture.tsx"], ends: /^ 2 pass\n 1 fail$/m },
  { fixtures: ["./sim-tui/fixtures/host.fixture.tsx", "./sim-tui/fixtures/tmp-fail.fixture.tsx"], ends: /^ 5 pass\n 1 fail$/m },
]

/** A child's whole output, as text. */
const text = (stream: Stream.Stream<Uint8Array, unknown>) => stream.pipe(Stream.decodeText(), Stream.mkString)

for (const { fixtures, ends } of CASES)
  platformTest(
    `${fixtures.join(" and ")}: the temp directory is left as it was found`,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const root = path.dirname(yield* path.fromFileUrl(new URL(".", import.meta.url)))
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "sim-tui-tmp-guard-" })
      const child = yield* spawner.spawn(
        ChildProcess.make(process.execPath, ["test", "--timeout", String(RUN_MS), ...fixtures], {
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
    hangGuard("installer"),
  )
