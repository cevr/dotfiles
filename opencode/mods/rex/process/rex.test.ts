// Rex over its tool, against a stand-in tool (fake-rex.sh) that logs its
// arguments: each call names the session, a split asks for the showcase
// beside the caller, and a failing or garbled tool is RexFailed with what it
// said.
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Context, Effect, Exit, Layer, Option } from "effect"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { Rex } from "../service.ts"
import * as ProcessRex from "./rex.ts"

const FAKE = fileURLToPath(new URL("./fake-rex.sh", import.meta.url))

/** The calls the stand-in tool got, one line of arguments each. */
class Calls extends Context.Service<Calls, Effect.Effect<ReadonlyArray<string>>>()("test/FakeRexCalls") {}

/**
 * The stand-in tool in `mode` as Rex, and the calls it got, in a scratch
 * folder removed when the test ends: a wrapper sets the tool's log and mode,
 * as the adapter passes the tool no environment of its own.
 */
const fake = (mode: string) =>
  Layer.unwrap(
    Effect.map(
      Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "fake-rex-"))),
        (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
      ),
      (dir) => {
        const log = join(dir, "log")
        const tool = join(dir, "rex")
        writeFileSync(log, "")
        writeFileSync(tool, `#!/bin/sh\nFAKE_REX_LOG='${log}' FAKE_REX_MODE='${mode}' exec '${FAKE}' "$@"\n`)
        chmodSync(tool, 0o755)
        const calls = Effect.sync(() => readFileSync(log, "utf8").split("\n").filter((line) => line !== ""))
        return Layer.merge(ProcessRex.layer(tool), Layer.succeed(Calls, calls))
      },
    ),
  )

describe("Rex over its tool", () => {
  const called = Calls.use((calls) => calls)
  effectTest(
    "lists the session's blocks with their labels, an unlabeled block as empty",
    Effect.gen(function* () {
      const rex = yield* Rex
      expect(yield* rex.blocks("session:a")).toEqual([{ id: "block:1", label: "shell" }, { id: "block:2", label: "showcase" }, { id: "block:3", label: "" }])
      expect(yield* called).toEqual(["block ls -s session:a --json"])
    }).pipe(Effect.provide(fake("ok"))),
    10_000,
  )

  effectTest(
    "splits the showcase off to the right of the caller, unfocused, its program after --",
    Effect.gen(function* () {
      const rex = yield* Rex
      expect(yield* rex.split({ session: "session:a", beside: "block:1", label: "showcase", command: ["rex-show", "view"] })).toBe("block:new")
      expect(yield* called).toEqual(["split -s session:a -b block:1 --split=right --ratio=40 --label=showcase --focus=false --json -- rex-show view"])
      yield* rex.split({ session: "session:a", beside: "block:1", label: "leaf", command: ["leaf", "diff"], cwd: "/work/repo" })
      expect((yield* called)[1]).toBe("split -s session:a -b block:1 --split=right --ratio=40 --label=leaf --focus=false -c /work/repo --json -- leaf diff")
    }).pipe(Effect.provide(fake("ok"))),
    10_000,
  )

  effectTest(
    "with no tool anywhere, each call fails saying where it looked",
    Effect.gen(function* () {
      const rex = yield* Rex
      const exit = yield* Effect.exit(rex.blocks("session:a"))
      expect(String(exit)).toContain("rex not found: not in $REX_BIN_DIR, on $PATH or in /Applications/Rex Beta.app")
    }).pipe(Effect.provide(ProcessRex.missing)),
    10_000,
  )

  effectTest(
    "a close that fails because the block is already gone is what was asked",
    Effect.gen(function* () {
      const rex = yield* Rex
      yield* rex.close("session:a", "block:2")
      expect(yield* called).toEqual(["block close -s session:a block:2", "block ls -s session:a --json"])
    }).pipe(Effect.provide(fake("gone"))),
    10_000,
  )

  effectTest(
    "a block runs while its terminal has a child, not once its program exited, nor once it is gone",
    Effect.gen(function* () {
      const rex = yield* Rex
      expect(yield* rex.running("session:a", "block:2")).toBe(true)
      expect(yield* rex.running("session:a", "block:3")).toBe(false)
      expect(yield* called).toEqual(["block call -s session:a -b block:2 process", "block call -s session:a -b block:3 process"])
    }).pipe(Effect.provide(fake("ok"))),
    10_000,
  )

  effectTest(
    "a block gone before its process is asked runs nothing",
    Effect.gen(function* () {
      const rex = yield* Rex
      expect(yield* rex.running("session:a", "block:2")).toBe(false)
    }).pipe(Effect.provide(fake("gone"))),
    10_000,
  )

  effectTest(
    "a failing tool is RexFailed with its words",
    Effect.gen(function* () {
      const rex = yield* Rex
      expect(String(yield* Effect.exit(rex.blocks("session:a")))).toContain("exit 3: no such session")
    }).pipe(Effect.provide(fake("fail"))),
    10_000,
  )

  effectTest(
    "a garbled answer is RexFailed naming the output",
    Effect.gen(function* () {
      const rex = yield* Rex
      const exit = yield* Effect.exit(rex.blocks("session:a"))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("unexpected output")
    }).pipe(Effect.provide(fake("garbage"))),
    10_000,
  )
})

describe("where Rex's tool is found", () => {
  const beta = "/Applications/Rex Beta.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex"
  const plain = "/Applications/Rex.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex"
  const among = (files: ReadonlyArray<string>) => (file: string) => files.includes(file)
  test("beside the Rex that opened the terminal first, then on PATH in order, then in the Rex Beta app, then the Rex app; none when nowhere", () => {
    const all = ["/rex/bin/rex", "/usr/local/bin/rex", "/opt/bin/rex", beta, plain]
    expect(ProcessRex.rexBin(Option.some("/rex/bin"), "/usr/local/bin:/opt/bin", among(all))).toEqual(Option.some("/rex/bin/rex"))
    expect(ProcessRex.rexBin(Option.none(), "/nowhere::/opt/bin:/usr/local/bin", among(all))).toEqual(Option.some("/opt/bin/rex"))
    expect(ProcessRex.rexBin(Option.some("/gone"), "/usr/bin", among([beta, plain]))).toEqual(Option.some(beta))
    expect(ProcessRex.rexBin(Option.none(), "/usr/bin", among([plain]))).toEqual(Option.some(plain))
    expect(ProcessRex.rexBin(Option.none(), "", among([]))).toEqual(Option.none())
  })
})
