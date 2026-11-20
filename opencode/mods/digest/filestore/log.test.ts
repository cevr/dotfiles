import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { Effect, Path } from "effect"
import { scratch } from "../../../tests/scratch.ts"
import { byteLength, decodeLines, DigestEvent, encodeLine, MAX_LINE, VERSION } from "../event.ts"
import { fileOf, make } from "./log.ts"

const WRITERS = 4
const EACH = 40

/** The writer process's file, beside this one. */
const writerFile = Effect.flatMap(Path.Path, (path) => path.fromFileUrl(new URL("./log-writer.ts", import.meta.url))).pipe(Effect.provide(Path.layer), Effect.orDie)

/** `count` writer processes appending EACH lines at once to the log in `dir`, each in its own group; their exit codes. */
const writeAtOnce = (dir: string, count: number) =>
  Effect.acquireUseRelease(
    Effect.map(writerFile, (writer) =>
      Array.from({ length: count }, (_, at) => Bun.spawn(["bun", writer, dir, `w${at}`, String(EACH)], { stdout: "ignore", stderr: "pipe", detached: true })),
    ),
    (children) => Effect.forEach(children, (child) => Effect.promise(() => child.exited), { concurrency: children.length }).pipe(Effect.timeout("20 seconds"), Effect.orDie),
    (children) => Effect.sync(() => children.forEach((child) => child.kill())),
  )

describe("the digest's file log", () => {
  test("a line in is a line out, in its month's file", async () => {
    using held = scratch("digest-log-")
    const dir = join(held.path, "one")
    const log = make(dir)
    const t = Date.parse("2026-11-20T12:00:00Z")
    const line = encodeLine(DigestEvent.cases.Check.make({ v: VERSION, t, root: "r", ok: false, text: "the accept check FAILED" }))
    await Effect.runPromise(log.append(line, t))
    expect(readdirSync(dir)).toEqual(["events-2026-11.jsonl"])
    expect(fileOf(dir, t)).toBe(join(dir, "events-2026-11.jsonl"))
    const read = decodeLines(await Effect.runPromise(log.read))
    expect([read.events.length, read.bad]).toEqual([1, 0])
  })

  test("a missing log reads as empty", async () => {
    using held = scratch("digest-log-")
    expect(await Effect.runPromise(make(join(held.path, "none")).read)).toBe("")
  })

  test("several processes appending at once never tear or interleave a line", async () => {
    using held = scratch("digest-log-")
    const dir = join(held.path, "many")
    const codes = await Effect.runPromise(writeAtOnce(dir, WRITERS))
    expect(codes).toEqual(Array.from({ length: WRITERS }, () => 0))
    const text = await Effect.runPromise(make(dir).read)
    const lines = text.split("\n").filter((line) => line !== "")
    expect(lines.every((line) => byteLength(line) <= MAX_LINE)).toBe(true)
    const read = decodeLines(text)
    expect([read.events.length, read.bad]).toEqual([WRITERS * EACH, 0])
  }, 30_000)
})
