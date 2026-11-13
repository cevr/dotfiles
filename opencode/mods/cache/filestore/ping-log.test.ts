import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { pingLogLaws } from "../laws.ts"
import { layer, make } from "./ping-log.ts"

/** A scratch directory for one case, removed when it ends. */
const scratch = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "cache-keepalive-"))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
)

pingLogLaws("the JSONL keepalive log", () => Layer.unwrap(Effect.map(scratch, (dir) => layer(join(dir, "nested/keepalive.jsonl")))))

describe("the JSONL keepalive log", () => {
  test("a line that does not decode is skipped, the rest read", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const path = join(yield* scratch, "mixed.jsonl")
          const good = (at: number) =>
            `{"at":${at},"host":"mac","sessionID":"s","model":"a/b","ping":1,"gapMs":270000,"ttlMs":300000,"status":200,"input":3,"read":9,"write":0,"output":1,"limits":{}}`
          yield* Effect.promise(() => writeFile(path, `${good(1)}\nnot json\n{"at":"soon"}\n\n${good(2)}\n`))
          const read = yield* make(path).read
          expect(read.map((line) => line.at)).toEqual([1, 2])
        }),
      ),
    ))
})
