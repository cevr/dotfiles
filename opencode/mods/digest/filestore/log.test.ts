// @reads all
// @reads-reason computed read at mods/digest/filestore/log.test.ts: expect([statSync(dir).mode & 0o777, statSync(fileOf(dir, T)).mode & 0o777]).toEqual([0o700, 0o6
import { describe, expect, test } from "bun:test"
import { appendFileSync, chmodSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Exit, Option, Path } from "effect"
import { scratch } from "../../../tests/scratch.ts"
import { byteLength, decodeLines, DigestEvent, encodeLine, MAX_LINE, VERSION } from "../event.ts"
import { fileOf, make, type Sink, writeLine } from "./log.ts"

const WRITERS = 4
const EACH = 40
const T = Date.parse("2026-11-20T12:00:00Z")

const check = (t: number, text: string) => DigestEvent.cases.Check.make({ v: VERSION, t, root: "r", ok: true, text })
const textsOf = (events: ReadonlyArray<DigestEvent>) => events.flatMap((event) => (event._tag === "Check" && [event.text]) || [])

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

  test("a line appended after a torn last line is read; only the torn line is counted bad", async () => {
    using held = scratch("digest-log-")
    const dir = join(held.path, "torn")
    const log = make(dir)
    await Effect.runPromise(log.append(encodeLine(check(T, "first")), T))
    // A crash mid-write: half a line, no newline.
    appendFileSync(fileOf(dir, T), encodeLine(check(T + 1, "torn")).slice(0, 20))
    await Effect.runPromise(log.append(encodeLine(check(T + 2, "after the restart")), T + 2))
    const read = decodeLines(await Effect.runPromise(log.read))
    expect([textsOf(read.events), read.bad]).toEqual([["first", "after the restart"], 1])
  })

  test("any prefix of a valid log, then N appends: those N lines read back, and at most the cut line is bad", async () => {
    using held = scratch("digest-log-")
    const whole = `${[1, 2, 3].map((at) => encodeLine(check(T + at, `old ${at}`))).join("\n")}\n`
    const bytes = new TextEncoder().encode(whole)
    const fresh = ["new a", "new b"]
    for (let cut = 0; cut <= bytes.length; cut++) {
      const dir = join(held.path, `cut-${cut}`)
      mkdirSync(dir)
      writeFileSync(fileOf(dir, T), bytes.slice(0, cut))
      const log = make(dir)
      await Effect.runPromise(Effect.forEach(fresh, (text, at) => log.append(encodeLine(check(T + 10 + at, text)), T), { discard: true }))
      const read = decodeLines(await Effect.runPromise(log.read))
      expect({ cut, tail: textsOf(read.events).slice(-2), bad: read.bad <= 1 }).toEqual({ cut, tail: fresh, bad: true })
    }
  })

  test("a short write fails the append and ends its piece, so the next line is read and the piece counts bad once", async () => {
    const written: Array<Uint8Array> = []
    const sink = (limit: number): Sink => ({
      lastByte: Effect.sync(() => Option.fromUndefinedOr(written.at(-1)?.at(-1))),
      write: (bytes) =>
        Effect.sync(() => {
          const kept = bytes.slice(0, Math.min(limit, bytes.length))
          written.push(kept)
          return kept.length
        }),
    })
    const first = encodeLine(check(T, "cut short"))
    expect(Exit.isFailure(await Effect.runPromiseExit(writeLine(sink(10), first)))).toBe(true)
    await Effect.runPromise(writeLine(sink(Number.MAX_SAFE_INTEGER), encodeLine(check(T + 1, "next"))))
    const read = decodeLines(written.map((bytes) => new TextDecoder().decode(bytes)).join(""))
    expect([textsOf(read.events), read.bad]).toEqual([["next"], 1])
  })

  test("the log's folder is 0700 and its files 0600, a 0644 file already there tightened at its next append", async () => {
    using held = scratch("digest-log-")
    const dir = join(held.path, "modes")
    const log = make(dir)
    await Effect.runPromise(log.append(encodeLine(check(T, "one")), T))
    expect([statSync(dir).mode & 0o777, statSync(fileOf(dir, T)).mode & 0o777]).toEqual([0o700, 0o600])
    chmodSync(fileOf(dir, T), 0o644)
    chmodSync(dir, 0o755)
    await Effect.runPromise(log.append(encodeLine(check(T + 1, "two")), T + 1))
    expect([statSync(dir).mode & 0o777, statSync(fileOf(dir, T)).mode & 0o777]).toEqual([0o700, 0o600])
  })
})
