import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Option } from "effect"
import { requestLogLaws } from "../laws.ts"
import { RequestLog } from "../service.ts"
import { layer, parse } from "./request-log.ts"

const scratch = mkdtempSync(join(tmpdir(), "cache-ledger-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let files = 0

requestLogLaws("the JSONL ledger", () => layer(join(scratch, `nested/${files++}/ledger.jsonl`)))

describe("the JSONL ledger", () => {
  test("a line that does not decode is skipped, the rest read", async () => {
    const path = join(scratch, "mixed.jsonl")
    const good = { at: 1, host: "mac", sessionID: "s", kind: "primary", agent: "build", model: "a/b", ttlMs: 1, prompt: 2, read: 1, write: 1, cause: "hit" }
    writeFileSync(path, `${JSON.stringify(good)}\nnot json\n{"at":"soon"}\n\n${JSON.stringify({ ...good, at: 2 })}\n`)
    const read = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* RequestLog).read
      }).pipe(Effect.provide(layer(path))),
    )
    expect(read.map((line) => line.at)).toEqual([1, 2])
    expect(parse("")).toEqual([])
  })

  test("a kept request that does not decode reads as none, and a session id that is no plain word is kept nowhere", async () => {
    const path = join(scratch, "kept/ledger.jsonl")
    mkdirSync(join(scratch, "kept/last"), { recursive: true })
    writeFileSync(join(scratch, "kept/last/ses_bad.json"), "{ not json")
    const [bad, escaped] = await Effect.runPromise(
      Effect.gen(function* () {
        const log = yield* RequestLog
        const kept = { sent: { at: 1, kind: "primary", agent: "build", model: "a/b", ttlMs: 1, segments: [] }, tokens: { prompt: 1, read: 0, write: 1 }, compacted: false } as const
        yield* log.keep("../escape", kept)
        return [yield* log.last("ses_bad"), yield* log.last("../escape")] as const
      }).pipe(Effect.provide(layer(path))),
    )
    expect(Option.isNone(bad)).toBe(true)
    expect(Option.isNone(escaped)).toBe(true)
    expect(existsSync(join(scratch, "kept/escape.json"))).toBe(false)
  })
})
