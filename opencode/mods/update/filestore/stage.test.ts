import { describe, expect, test } from "bun:test"
import { spawnSync } from "bun"
import { Effect, Option } from "effect"
import { buildName } from "../builds.ts"
import { parseRecord } from "../record.ts"
import { stageBuild, type Stage } from "./stage.ts"

const VERSION = "2.2.7-prime.abcdef12"

const sh = (script: string) => spawnSync(["/bin/sh", "-c", script], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })

/** The entries of `dir`, none when it does not exist. */
const entries = (dir: string): ReadonlyArray<string> =>
  sh(`ls '${dir}' 2>/dev/null`)
    .stdout.toString()
    .split("\n")
    .filter((line) => line !== "")

const exists = (path: string): boolean => sh(`test -e '${path}'`).exitCode === 0

/** Runs `body` on a scratch host (a built binary, an empty share directory, no record yet), removing it after. */
const onScratch = (body: (stage: Stage) => void) =>
  Effect.runSync(
    Effect.acquireUseRelease(
      Effect.sync(() => sh("mktemp -d -t update-stage").stdout.toString().trim()),
      (dir) =>
        Effect.sync(() => {
          sh(`mkdir -p '${dir}/build' && printf binary > '${dir}/build/opencode'`)
          body({ built: `${dir}/build/opencode`, share: `${dir}/share`, version: VERSION, record: `${dir}/state/opencode/installed.json`, lock: `${dir}/state/builds.lock`, dotfiles: "d".repeat(40), fork: "f".repeat(40), pid: 71234 })
        }),
      (dir) => Effect.sync(() => void spawnSync(["rm", "-rf", dir])),
    ),
  )

describe("daily's stage of a build", () => {
  test("takes the builds lock exclusively before the copy reaches the share directory, and stages the build and its record under it", () =>
    onScratch((stage) => {
      const taken: Array<{ operation: number; share: ReadonlyArray<string> }> = []
      const flock = (_descriptor: number, operation: number) => {
        taken.push({ operation, share: entries(stage.share) })
        return 0
      }
      const binary = stageBuild(stage, flock)
      expect(taken).toEqual([{ operation: 2, share: [] }])
      expect(exists(stage.lock)).toBe(true)
      expect(binary).toBe(`${stage.share}/${buildName(VERSION)}`)
      expect(entries(stage.share)).toEqual([buildName(VERSION)])
      const record = parseRecord(sh(`cat '${stage.record}'`).stdout.toString())
      expect(Option.map(Option.flatMap(record, (each) => Option.fromNullishOr(each.staged)), (staged) => staged.version)).toEqual(Option.some(VERSION))
    }))

  test("a lock that does not take stages nothing", () =>
    onScratch((stage) => {
      expect(() => stageBuild(stage, () => -1)).toThrow()
      expect(entries(stage.share)).toEqual([])
      expect(exists(stage.record)).toBe(false)
    }))

  test("with libc's flock, on a free lock, it stages", () =>
    onScratch((stage) => {
      stageBuild(stage)
      expect(entries(stage.share)).toEqual([buildName(VERSION)])
    }))
})
