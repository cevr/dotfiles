// The runs' files on disk, against the memory files the simulated tests use: the same files answer the same units,
// unit and last verify in both. The request's head is read as the skill's request.ts reads it.
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { headOf } from "../../../../skills/orchestrate/scripts/request.ts"
import { scratch } from "../../../tests/scratch.ts"
import * as MemoryRunFiles from "../memory/run-files.ts"
import { RunFiles } from "../service.ts"
import { requestHeadOf } from "../tools.ts"
import * as FileRunFiles from "./run-files.ts"

const sha = (n: number) => n.toString(16).padStart(40, "0")
const T0 = Date.parse("2026-11-14T10:00:00Z")

/** The run dir's files, by path under the run, and when each was written (minutes after T0). */
const FILES: ReadonlyArray<readonly [string, string, number]> = [
  ["a/log.md", "2026-11-14T10:00Z implement → ready r2\n", 0],
  ["a/round-1-request.md", `Head: ${sha(1)}\n`, 1],
  ["a/round-2-request.md", `Range 1234567..${sha(2).slice(0, 9)}\n`, 2],
  ["a/round-1-findings.md", "verifier batch-1 r1: changes /x\n", 3],
  ["b/log.md", "2026-11-14T10:00Z plan → implement r1\n", 0],
  ["c/spec.md", "a spec, no log: no unit dir\n", 0],
  ["verify-old/batch-old.md", `# batch-old\nBase: ${sha(5)}\nHead: ${sha(6)}\n`, 4],
  ["verify-old/batch-old-findings.md", "Verdict: ACCEPTED\n", 5],
  ["verify-new/batch-new.md", `# batch-new\nHead: ${sha(7)}\n`, 6],
  ["verify-new/batch-new-findings.md", "verifier batch-new r1: changes /x\n", 9],
  ["verify-open/batch-open.md", `Head: ${sha(8)}\n`, 10],
  ["verify-open/batch-open-findings.md", "still verifying\n", 11],
]

/** The files the memory adapter holds: each test puts there what it writes to disk. */
const MEMORY: MemoryRunFiles.Files = new Map()

/** The run dir's files written to disk under `root` (with their times) and into memory; the run dir. */
const runDir = (root: string) => {
  const dir = join(root, "run")
  for (const [file, text, minutes] of FILES) {
    const at = join(dir, file)
    const when = T0 + minutes * 60_000
    mkdirSync(dirname(at), { recursive: true })
    writeFileSync(at, text)
    // utimes takes seconds.
    utimesSync(at, when / 1000, when / 1000)
    MEMORY.set(at, { text, at: when })
  }
  return dir
}

/** A test's program over the RunFiles a layer builds, in a scratch dir that lives until it ends. */
const run = <A, E>(layer: Layer.Layer<RunFiles>, body: (files: RunFiles["Service"], root: string) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(Effect.sync(() => scratch("run-files-")), (dir) => Effect.sync(() => dir[Symbol.dispose]()))
        return yield* body(Context.get(yield* Layer.build(layer), RunFiles), root.path)
      }),
    ),
  )

const ADAPTERS: ReadonlyArray<readonly [string, Layer.Layer<RunFiles>]> = [
  ["disk", FileRunFiles.layer],
  ["memory", MemoryRunFiles.layer(MEMORY)],
]

for (const [name, adapter] of ADAPTERS)
  describe(`RunFiles (${name})`, () => {
    test("one run dir answers its units, a unit's newest request and findings, and the last verify", () =>
      run(adapter, (files, root) =>
        Effect.gen(function* () {
          const dir = runDir(root)
          const answers = yield* Effect.all({ units: files.units(dir), a: files.unit(join(dir, "a")), verified: files.verified([dir, join(root, "none")]) })
          expect(answers.units.map((unit) => unit.unit).toSorted()).toEqual(["a", "b"])
          expect(answers.a).toEqual({
            unit: "a",
            dir: join(dir, "a"),
            request: Option.some({ round: 2, path: join(dir, "a/round-2-request.md"), head: Option.some(sha(2).slice(0, 9)) }),
            findings: Option.some({ round: 1, path: join(dir, "a/round-1-findings.md"), verdict: Option.some("changes") }),
          })
          // The newest verify by its verdict's time; one whose findings hold no verdict line is none.
          expect(answers.verified).toEqual(Option.some({ file: join(dir, "verify-new/batch-new.md"), head: sha(7), at: T0 + 9 * 60_000 }))
        }),
      ))
  })

describe("RunFiles (disk only)", () => {
  test("a write makes the batch file's directory; a path it cannot take fails as unwritten", () =>
    run(FileRunFiles.layer, (files, root) =>
      Effect.gen(function* () {
        const file = join(root, "written/verify-main-abc1234/batch-main-abc1234.md")
        yield* files.write(file, "# batch\n")
        expect(readFileSync(file, "utf8")).toBe("# batch\n")
        const blocked = join(root, "blocked")
        writeFileSync(blocked, "a file, not a dir")
        const failed = yield* Effect.flip(files.write(join(blocked, "x/batch.md"), "x"))
        expect(failed._tag).toBe("RunFileUnwritten")
      }),
    ))

  test("the request's head is the skill's request.ts headOf", () => {
    for (const text of [`Head: ${sha(9)}\n`, "- base 1234567, head commit abcdef01.", "Range 1234567..89abcde, 3 files", "no head here", `head ${sha(3).slice(0, 12)} and ${sha(4)}`, "base..head: 1111111..2222222"])
      expect({ text, head: requestHeadOf(text) }).toEqual({ text, head: Option.fromNullishOr(headOf(text)) })
  })
})
