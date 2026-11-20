import { describe, expect, test } from "bun:test"
import { Duration, Effect, Logger, Option, Ref, Schema } from "effect"
import { TestClock } from "effect/testing"
import { decodeLine, DigestEvent, DigestLog, VERSION } from "./event.ts"
import { layer, RelayHold, RETRIES, RETRY_EVERY, SEND_TIMEOUT } from "./relay.ts"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const check = (t: number) => DigestEvent.cases.Check.make({ v: VERSION, t, root: "r", ok: true, text: `check ${t}` })

/** The digest's end of the wire: lines it took, and whether it answers now. */
const wireOf = () => {
  const up = Ref.makeUnsafe(false)
  /** While set, a send never settles: a stalled digest. */
  const hangs = Ref.makeUnsafe(false)
  const got = Ref.makeUnsafe<ReadonlyArray<string>>([])
  /** The warnings the relay logged, with their annotations. */
  const warned: Array<string> = []
  const send = (line: string): Effect.Effect<void, string> =>
    Effect.flatMap(Effect.all([Ref.get(up), Ref.get(hangs)]), ([answers, hung]) => {
      if (hung) return Effect.never
      if (answers) return Ref.update(got, (lines) => [...lines, line])
      return Effect.fail("no digest plugin")
    })
  const logger = Logger.make(({ message }) => void warned.push(encodeJson(message)))
  return { up, hangs, got, warned, send, logger }
}

/** Lets every forked fiber run until it waits on the clock. */
const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true })

const tags = (lines: ReadonlyArray<string>) => lines.flatMap((line) => Option.toArray(Option.map(decodeLine(line), (event) => [event._tag, event._tag === "Dropped" && event.count])))

const run = <A>(body: (world: ReturnType<typeof wireOf>) => Effect.Effect<A, never, DigestLog | RelayHold>, hold = 4) => {
  const world = wireOf()
  return Effect.runPromise(body(world).pipe(Effect.provide(layer(world.send, hold)), Effect.scoped, Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([world.logger]))))
}

describe("the relay", () => {
  test("an event sent before the digest answers is held, never fails the writer, and goes once it answers", async () => {
    const got = await run((world) =>
      Effect.gen(function* () {
        const log = yield* DigestLog
        yield* log.append(check(1))
        yield* settle
        expect(yield* Ref.get(world.got)).toEqual([])
        yield* Ref.set(world.up, true)
        yield* TestClock.adjust(RETRY_EVERY)
        yield* settle
        return yield* Ref.get(world.got)
      }),
    )
    expect(tags(got)).toEqual([["Check", false]])
  })

  test("a full hold drops the newest lines, counts them, and writes the count once the digest answers", async () => {
    const [got, waiting] = await run((world) =>
      Effect.gen(function* () {
        const log = yield* DigestLog
        // One line is in flight; four wait; the other three are dropped.
        for (let t = 1; t <= 8; t++) {
          yield* log.append(check(t))
          yield* settle
        }
        const hold = yield* RelayHold
        expect(yield* hold.dropped).toBe(3)
        yield* Ref.set(world.up, true)
        yield* TestClock.adjust(RETRY_EVERY)
        yield* settle
        return [yield* Ref.get(world.got), yield* hold.waiting] as const
      }),
    )
    expect(tags(got)).toEqual([["Check", false], ["Dropped", 3], ["Check", false], ["Check", false], ["Check", false], ["Check", false]])
    expect(waiting).toBe(0)
  })

  test("a line the digest never takes in RETRIES tries is dropped and counted, and the count goes once it answers", async () => {
    const got = await run((world) =>
      Effect.gen(function* () {
        const log = yield* DigestLog
        yield* log.append(check(1))
        yield* settle
        yield* TestClock.adjust(Duration.times(Duration.fromInputUnsafe(RETRY_EVERY), RETRIES + 1))
        yield* settle
        yield* Ref.set(world.up, true)
        yield* TestClock.adjust(RETRY_EVERY)
        yield* settle
        return yield* Ref.get(world.got)
      }),
    )
    expect(tags(got)).toEqual([["Dropped", 1]])
  })

  test("with the digest answering, each append is one line, in order", async () => {
    const got = await run((world) =>
      Effect.gen(function* () {
        yield* Ref.set(world.up, true)
        const log = yield* DigestLog
        yield* Effect.forEach([1, 2, 3], (t) => log.append(check(t)), { discard: true })
        yield* settle
        return yield* Ref.get(world.got)
      }),
    )
    expect(got.length).toBe(3)
  })

  test("a send that never settles times out and is tried again, so one stuck call cannot pin the hold", async () => {
    const got = await run((world) =>
      Effect.gen(function* () {
        yield* Ref.set(world.hangs, true)
        const log = yield* DigestLog
        yield* log.append(check(1))
        yield* settle
        yield* Ref.set(world.hangs, false)
        yield* Ref.set(world.up, true)
        yield* TestClock.adjust(Duration.sum(Duration.fromInputUnsafe(SEND_TIMEOUT), Duration.fromInputUnsafe(RETRY_EVERY)))
        yield* settle
        yield* log.append(check(2))
        yield* settle
        return yield* Ref.get(world.got)
      }),
    )
    expect(tags(got)).toEqual([["Check", false], ["Check", false]])
  })

  test("a drop is logged once per cause, with the count so far: a full hold, then a line never sent", async () => {
    const warned = await run((world) =>
      Effect.gen(function* () {
        const log = yield* DigestLog
        // One in flight, four held, three dropped as the hold is full: one warning, at the first.
        for (let t = 1; t <= 8; t++) {
          yield* log.append(check(t))
          yield* settle
        }
        // Every held line, and the count, run out of tries: one more warning, its cause the send's failure.
        yield* TestClock.adjust(Duration.times(Duration.fromInputUnsafe(RETRY_EVERY), (RETRIES + 1) * 7))
        yield* settle
        return world.warned
      }),
    )
    expect(warned.length).toBe(2)
    expect(warned[0]).toContain("the hold is full")
    expect(warned[0]).toContain('"dropped":1')
    expect(warned[1]).toContain("no digest plugin")
  })
})
