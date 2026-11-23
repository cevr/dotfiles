// @reads all
// @reads-reason subprocess reads at mods/questions/opencode/race.test.ts: Effect.sync(() => Bun.spawn(["bun", PROGRAM, ...args], { stdout: "pipe", stderr: "pipe", detach
// Two servers answer the same questions at once (the tray in one, the digest page in another), over the fork's real
// key-value table in one sqlite file: each question is answered once, by one of them; its session gets one letter;
// the digest one Answered line, naming who won; the loser is told the question is no longer open.
//
// - Each server is its own process (race.ts), so the race is on the fork's KV.setIf statement across sqlite
//   connections, not on anything in this process.
// - Round 1's verifier wrote the harness. Its mutant (BLIND=1: write over whatever rev is stored now) failed 156 of
//   1000 sessions there.
// - Run it at a larger count by hand with RACE_SESSIONS=1000, and its mutant with BLIND=1 (it must fail).
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { Array as Arr, Config, Effect, Option, Predicate, Schema } from "effect"
import { scratch } from "../../../tests/scratch.ts"
import { Fact, sessionOf } from "./race.ts"

/** The race program, from opencode/ (where the tests run). */
const PROGRAM = "mods/questions/opencode/race.ts"
const decodeFact = Schema.decodeUnknownOption(Schema.fromJsonString(Fact))
const COUNT = Effect.runSync(Config.Number("RACE_SESSIONS").pipe(Config.withDefault(200)))

/** One race process, in its own process group; its facts, once it exits 0. A minute at most, then its group is killed. */
const run = (args: ReadonlyArray<string>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => Bun.spawn(["bun", PROGRAM, ...args], { stdout: "pipe", stderr: "pipe", detached: true })),
    (child) =>
      Effect.all([Effect.promise(() => new Response(child.stdout).text()), Effect.promise(() => new Response(child.stderr).text()), Effect.promise(() => child.exited)], { concurrency: 3 }).pipe(
        Effect.map(([out, err, code]) => {
          // A failed process says why.
          expect({ code, err: "".padEnd(Number(code !== 0) * err.length, err) }).toEqual({ code: 0, err: "" })
          return out.split("\n").flatMap((line) => Option.toArray(decodeFact(line)))
        }),
        Effect.timeout("60 seconds"),
      ),
    // Still running (timed out): its whole group goes.
    (child) => Effect.sync(() => void Option.map(Option.liftPredicate(child, (each) => !Predicate.isNumber(each.exitCode)), (each) => process.kill(-each.pid, "SIGKILL"))),
  )

/** The facts of one kind. */
const ofTag = <T extends Fact["_tag"]>(facts: ReadonlyArray<Fact>, tag: T) => facts.filter((fact): fact is Extract<Fact, { readonly _tag: T }> => fact._tag === tag)

describe("two servers answering at once over the fork's real key-value table", () => {
  test(`each of ${COUNT} questions is answered once: one letter, one Answered line naming the winner, the loser told it is not open`, async () => {
    using held = scratch("questions-race-")
    const db = join(held.path, "kv.sqlite")
    const facts = await Effect.runPromise(
      Effect.gen(function* () {
        yield* run(["setup", db, String(COUNT)])
        return Arr.flatten(yield* Effect.all([run(["answer", db, String(COUNT), "tray"]), run(["answer", db, String(COUNT), "page"])], { concurrency: 2 }))
      }),
    )
    const letters = ofTag(facts, "Letter")
    const answeredLines = ofTag(facts, "Digest").map((fact) => fact.line).filter((line) => line.includes('"_tag":"Answered"'))
    const outcomes = ofTag(facts, "Outcome")
    const wrong = Array.from({ length: COUNT }, (_, index) => index).flatMap((index) => {
      const session = sessionOf(index)
      const mine = letters.filter((letter) => letter.sessionID === session)
      const lines = answeredLines.filter((line) => line.includes(`"${session}"`))
      const tries = outcomes.filter((outcome) => outcome.index === index)
      const won = tries.filter((outcome) => outcome.answered === 1)
      const lost = tries.filter((outcome) => outcome.answered === 0)
      const winner = won.map((outcome) => outcome.via)
      const ok =
        mine.length === 1 &&
        lines.length === 1 &&
        won.length === 1 &&
        lost.length === 1 &&
        lost.every((outcome) => /not open|NotOpen/.test(outcome.why)) &&
        mine.every((letter) => winner.includes(letter.via)) &&
        lines.every((line) => winner.some((via) => line.includes(`"via":"${via}"`)))
      return Option.toArray(Option.liftPredicate({ session, letters: mine.length, lines: lines.length, won: won.length, lost: lost.map((outcome) => outcome.why) }, () => !ok))
    })
    expect(wrong.slice(0, 5)).toEqual([])
    expect([letters.length, answeredLines.length, outcomes.length]).toEqual([COUNT, COUNT, 2 * COUNT])
  }, 120_000)
})
