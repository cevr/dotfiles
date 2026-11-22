// One process of the two-server race (race.test.ts): the questions model over the fork's real key-value table in the
// sqlite file `db`, as the plugin's storage is (packages/core/src/plugin/host.ts `storage`), so two processes race on
// the one statement the fork's KV.setIf is.
//
//   bun mods/questions/opencode/race.ts setup <db> <n>          one question asked in each of n sessions
//   bun mods/questions/opencode/race.ts answer <db> <n> <via>   each answered, as `via` (tray | page)
//
// It prints one JSON line per fact for the test to count: each letter delivered, each digest line, each answer's
// outcome. BLIND=1 runs the mutant the race once caught: a write over whatever rev is stored now, as `set` was.
import { Cause, Config, Console, Effect, Exit, Layer, Match, Option, Ref, Schema } from "effect"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { KV } from "@opencode/core/kv"
import { storage as hostStorage } from "@opencode/core/plugin/host"
import { DigestLog, encodeLine } from "@dotfiles/opencode-digest/event"
import * as Model from "../model.ts"
import { Via } from "../question.ts"
import { Changes, Courier, Family } from "../service.ts"
import * as OpenCodeStore from "./store.ts"

/** The i-th session of a race. */
export const sessionOf = (index: number) => `ses_race${String(index).padStart(5, "0")}`

/** What one process prints, one per line. */
export const Fact = Schema.TaggedUnion({
  Letter: { sessionID: Schema.String, delivery: Schema.String, text: Schema.String, via: Via },
  Digest: { line: Schema.String },
  Outcome: { index: Schema.Number, via: Via, answered: Schema.Number, why: Schema.String },
})
export type Fact = typeof Fact.Type

const encodeFact = Schema.encodeSync(Schema.fromJsonString(Fact))
const say = (fact: Fact) => Console.log(encodeFact(fact))

const PORT = { question: "Which port?", header: "Port", options: [{ label: "8080" }, { label: "3000" }], assume: "8080" }

/** The plugin's storage over the real table; blind, the mutant's. */
const storageOf = (kv: KV.Interface, blind: boolean): OpenCodeStore.Storage => {
  const real = hostStorage(kv, "questions")
  const revOf = Schema.decodeUnknownOption(Schema.Struct({ rev: Schema.Number }))
  return Option.match(Option.liftPredicate(real, () => blind), {
    onNone: () => real,
    onSome: () => ({
      ...real,
      setIf: (key, value) =>
        Effect.flatMap(real.get(key), (now) =>
          real.setIf(key, value, ...Option.toArray(Option.map(Option.fromUndefinedOr(now), (stored) => Option.getOrElse(Option.map(revOf(stored), (each) => each.rev), () => 0)))),
        ),
    }),
  })
}

/** The model over `storage`, its letters and digest lines printed. */
const modelOf = (storage: OpenCodeStore.Storage, via: Via) =>
  Model.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        OpenCodeStore.layer(storage),
        Layer.effect(
          Courier,
          Effect.map(Ref.make(0), (minted) => {
            const deliver = (sessionID: string, delivery: string, letter: { readonly text: string }) => say(Fact.cases.Letter.make({ sessionID, delivery, text: letter.text, via }))
            return Courier.of({ newDelivery: Effect.map(Ref.updateAndGet(minted, (count) => count + 1), (count) => `msg_${via}_${String(count).padStart(8, "0")}`), deliver, notify: deliver })
          }),
        ),
        Layer.succeed(Family, Family.of({ info: (id) => Effect.succeed({ id }) })),
        Layer.succeed(DigestLog, DigestLog.of({ append: (event) => say(Fact.cases.Digest.make({ line: encodeLine(event) })) })),
        Layer.succeed(Changes, Changes.of({ changed: () => Effect.void })),
      ),
    ),
  )

/** One process's part: ask in each of `count` sessions, or answer each as `via`. */
export const race = (mode: "setup" | "answer", db: string, count: number, via: Via, blind: boolean) => {
  const sessions = Array.from({ length: count }, (_, index) => index)
  // The tray answers 8080, the page 3000.
  const answer = Match.value(via).pipe(Match.when("tray", () => "8080"), Match.orElse(() => "3000"))
  const kv = AppNodeBuilder.build(KV.node, [Database.node.replace(Database.configured({ path: db }))])
  const model = Layer.unwrap(Effect.map(KV.Service, (each) => modelOf(storageOf(each, blind), via))).pipe(Layer.provide(kv))
  return Effect.gen(function* () {
    const questions = yield* Model.QuestionsModel
    if (mode === "setup") return yield* Effect.forEach(sessions, (index) => questions.ask(sessionOf(index), { questions: [PORT] }), { discard: true })
    yield* Effect.forEach(
      sessions,
      (index) =>
        Effect.flatMap(Effect.exit(questions.answer(sessionOf(index), [{ id: "q1", answer }], [], Option.none(), via)), (exit) =>
          say(
            Fact.cases.Outcome.make({
              index,
              via,
              answered: Exit.match(exit, { onSuccess: (value) => value.answered.length, onFailure: () => 0 }),
              why: Exit.match(exit, { onSuccess: () => "", onFailure: (cause) => String(Cause.squash(cause)) }),
            }),
          ),
        ),
      { discard: true },
    )
  }).pipe(Effect.provide(model))
}

const Args = Schema.Tuple([Schema.Literals(["setup", "answer"]), Schema.String, Schema.NumberFromString, Schema.optional(Via)])

if (import.meta.main)
  Effect.runFork(
    Effect.gen(function* () {
      const [mode, db, count, via] = yield* Schema.decodeUnknownEffect(Args)(Bun.argv.slice(2))
      const blind = yield* Config.Boolean("BLIND").pipe(Config.withDefault(false))
      yield* race(mode, db, count, Option.getOrElse(Option.fromUndefinedOr(via), () => "tray" as const), blind)
    }).pipe(Effect.orDie),
  )
