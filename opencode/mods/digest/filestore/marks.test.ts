// The owner's marks on disk (read.jsonl, names.jsonl): created 0600 in a 0700 folder like the log, read back the
// same after a restart, whole under two writing processes, and a file of an unknown version an error that leaves it
// as it is.
import { describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Exit, Option, Path } from "effect"
import { scratch } from "../../../tests/scratch.ts"
import { markOf, nameOf, sinceOf } from "../marks.ts"
import { make, NAMES_FILE, READ_FILE } from "./marks.ts"
import { hangGuard } from "../../../tests/hang-guard.ts"

const T = Date.parse("2026-11-20T12:00:00Z")
const EACH = 60

const writerFile = Effect.flatMap(Path.Path, (path) => path.fromFileUrl(new URL("./marks-writer.ts", import.meta.url))).pipe(Effect.provide(Path.layer), Effect.orDie)

/** Two writer processes appending EACH marks at once to the store in `dir`; their exit codes. */
const writeAtOnce = (dir: string) =>
  Effect.acquireUseRelease(
    Effect.map(writerFile, (writer) => ["w0", "w1"].map((name) => Bun.spawn(["bun", writer, dir, name, String(EACH)], { stdout: "ignore", stderr: "pipe", detached: true }))),
    (children) => Effect.forEach(children, (child) => Effect.promise(() => child.exited), { concurrency: 2 }).pipe(Effect.timeout("20 seconds"), Effect.orDie),
    (children) => Effect.sync(() => children.forEach((child) => child.kill())),
  )

describe("the marks' file store", () => {
  test("marks and names are kept 0600 in a 0700 folder, and read back the same by a new store (a restart)", async () => {
    using held = scratch("digest-marks-")
    const dir = join(held.path, "digest")
    const store = make(dir)
    await Effect.runPromise(store.append(sinceOf(T)))
    await Effect.runPromise(store.append(markOf("m1", T + 1, "read")))
    await Effect.runPromise(store.append(markOf("m2", T + 2, "later", Option.some(T + 10))))
    await Effect.runPromise(store.append(nameOf("harbor", "Harbor Lights", T + 3)))
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, READ_FILE)).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, NAMES_FILE)).mode & 0o777).toBe(0o600)
    const marks = await Effect.runPromise(make(dir).read)
    expect([Option.getOrNull(marks.since), [...marks.marks.keys()].toSorted(), marks.marks.get("m2")?.returnsAt, [...marks.names]]).toEqual([
      T,
      ["m1", "m2"],
      Option.some(T + 10),
      [["harbor", "Harbor Lights"]],
    ])
  })

  test("a store with no files reads as no marks", async () => {
    using held = scratch("digest-marks-")
    const marks = await Effect.runPromise(make(join(held.path, "none")).read)
    expect([marks.marks.size, marks.names.size, Option.isNone(marks.since)]).toEqual([0, 0, true])
  })

  test("two processes marking at once lose nothing", async () => {
    using held = scratch("digest-marks-")
    const dir = join(held.path, "two")
    expect(await Effect.runPromise(writeAtOnce(dir))).toEqual([0, 0])
    const marks = await Effect.runPromise(make(dir).read)
    expect([marks.marks.size, marks.names.size]).toEqual([2 * EACH, 2])
  }, hangGuard("local-fixture"))

  test("a file of an unknown version is a clear error on read and on write, and is left as it is", async () => {
    using held = scratch("digest-marks-")
    const dir = join(held.path, "newer")
    mkdirSync(dir, { recursive: true })
    const newer = `{"_tag":"Mark","v":2,"t":1,"id":"a","mark":"read","why":"a newer build"}\n`
    writeFileSync(join(dir, READ_FILE), newer)
    const read = await Effect.runPromiseExit(make(dir).read)
    expect(Exit.isFailure(read) && JSON.stringify(read.cause)).toContain("read.jsonl line 1 has version 2")
    const write = await Effect.runPromiseExit(make(dir).append(markOf("b", 2, "read")))
    expect(Exit.isFailure(write)).toBe(true)
    expect(readFileSync(join(dir, READ_FILE), "utf8")).toBe(newer)
  })
})
