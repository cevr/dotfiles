// An answer from the digest page whose server process is killed (SIGKILL) at each step, over the fork's real
// key-value table, then the restart's resend in a fresh process. Wherever it dies, the session gets the answer at
// most once, under one delivery id. It gets none only if the kill came before the answer was stored; then the
// question is still open, and he answers again.
//
// - Round 2's verifier wrote the harness (crash.ts).
// - O1, on base and not fixed here: a kill right after the store write never writes the digest's Answered line, so
//   the page keeps showing the question. This test pins only that no step writes more than one line. The todo below
//   is the follow-up.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Option, Predicate, Schema } from "effect"
import { scratch } from "../../../tests/scratch.ts"
import { DIGEST, LETTERS, Letter, SESSION, STEPS } from "./crash.ts"

/** The kill program, from opencode/ (where the tests run). */
const PROGRAM = "mods/questions/opencode/crash.ts"
const decodeLetter = Schema.decodeUnknownOption(Schema.fromJsonString(Letter))
const decodeOpen = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ open: Schema.Boolean })))

/** One process, in its own process group; its exit code and output. Half a minute at most, then its group is killed. */
const run = (args: ReadonlyArray<string>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => Bun.spawn(["bun", PROGRAM, ...args], { stdout: "pipe", stderr: "pipe", detached: true })),
    (child) =>
      Effect.all([Effect.promise(() => new Response(child.stdout).text()), Effect.promise(() => child.exited)], { concurrency: 2 }).pipe(
        Effect.map(([out, code]) => ({ out, code })),
        Effect.timeout("30 seconds"),
      ),
    (child) => Effect.sync(() => void Option.map(Option.liftPredicate(child, (each) => !Predicate.isNumber(each.exitCode) && !Predicate.isString(each.signalCode)), (each) => process.kill(-each.pid, "SIGKILL"))),
  )

const lines = (file: string) => Option.match(Option.liftPredicate(file, existsSync), { onNone: () => [], onSome: (each) => readFileSync(each, "utf8").split("\n") })

describe("an answer whose server is killed at each step, then restarted", () => {
  test.each([...STEPS])("killed at %s: at most one letter, under one id; the question closed if it was stored", async (step) => {
    using held = scratch("questions-crash-")
    const db = join(held.path, "kv.sqlite")
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const setup = yield* run(["setup", db, held.path])
        const answer = yield* run(["answer", db, held.path, step])
        const resend = yield* run(["resend", db, held.path])
        const check = yield* run(["check", db, held.path])
        return { codes: [setup.code, answer.code, resend.code, check.code], open: Option.map(decodeOpen(check.out.trim()), (each) => each.open) }
      }),
    )
    const letters = lines(join(held.path, LETTERS)).flatMap((line) => Option.toArray(decodeLetter(line))).filter((letter) => letter.sessionID === SESSION && letter.text.includes("3000"))
    const answered = lines(join(held.path, DIGEST)).filter((line) => line.includes('"_tag":"Answered"'))
    const stored = step !== "before-store"
    // The killed process exits by SIGKILL (no code: bun reports 137 or null), every other one 0.
    expect([seen.codes[0], seen.codes[2], seen.codes[3]]).toEqual([0, 0, 0])
    expect(seen.codes[1]).not.toBe(0)
    expect(new Set(letters.map((letter) => letter.delivery)).size).toBe(Number(stored))
    expect(seen.open).toEqual(Option.some(!stored))
    expect(answered.length).toBeLessThanOrEqual(1)
  }, 60_000)

  test.todo("O1: killed right after the store write, the digest still gets its Answered line after the restart")
})
