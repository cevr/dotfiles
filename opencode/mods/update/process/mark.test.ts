import { describe, expect, test } from "bun:test"
import { file, spawnSync } from "bun"
import { Effect, Option } from "effect"
import { HandoffMark } from "../service.ts"
import * as Mark from "./mark.ts"

/** A pid that no longer lives: a process that ran and ended. */
const deadPid = () => spawnSync(["true"]).pid

/** This test's own process: the parent of a shell it starts. */
const ownPid = () => Number(spawnSync(["sh", "-c", "echo $PPID"]).stdout.toString().trim())

/** A scratch directory for one test, removed after it. */
const scratch = <A>(body: (path: string) => Effect.Effect<A>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => spawnSync(["mktemp", "-d", "-t", "update-mark"]).stdout.toString().trim()),
    (dir) => body(`${dir}/handoff.json`),
    (dir) => Effect.sync(() => void spawnSync(["rm", "-rf", dir])),
  )

/** The mark of process `pid` at `path`. */
const markOf = (path: string, pid: number) => HandoffMark.pipe(Effect.provide(Mark.layer(path, pid)))

const exists = (path: string) => Effect.promise(() => file(path).exists())

describe("the handoff's mark over a real file and ps", () => {
  test("B1: the handoff holds its mark with its pid, ps finds it alive, and only its own release drops it", () =>
    Effect.runPromise(
      scratch((path) =>
        Effect.gen(function* () {
          const pid = ownPid()
          const mine = yield* markOf(path, pid)
          const other = yield* markOf(path, pid + 1)
          yield* mine.hold
          expect(Option.map(yield* other.read, (mark) => mark.pid)).toEqual(Option.some(pid))
          expect(yield* other.alive(pid)).toBe(true)
          yield* other.release
          expect(yield* exists(path)).toBe(true)
          yield* mine.release
          expect(yield* exists(path)).toBe(false)
          expect(yield* mine.read).toEqual(Option.none())
        }),
      ),
    ))

  test("B1: a pid that ended is not alive", () =>
    Effect.runPromise(
      scratch((path) =>
        Effect.gen(function* () {
          const mark = yield* markOf(path, 1)
          expect(yield* mark.alive(deadPid())).toBe(false)
        }),
      ),
    ))
})
