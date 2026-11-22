// One process of the kill test (crash.test.ts): the questions model over the fork's real key-value table in the
// sqlite file `db`, as race.ts runs it. Its answer is killed with SIGKILL at one step; a fresh process then runs the
// server start's resend.
//
//   bun mods/questions/opencode/crash.ts setup  <db> <dir>          one question asked
//   bun mods/questions/opencode/crash.ts answer <db> <dir> <step>   answered from the page, killed at <step>
//   bun mods/questions/opencode/crash.ts resend <db> <dir>          the restart: resend, twice
//   bun mods/questions/opencode/crash.ts check  <db> <dir>          whether the question is still open (one JSON line)
//
// Letters and digest lines go to files in <dir>, written before the next step runs, so a kill loses none. The fork's
// inbox keeps one message per delivery id (packages/core/src/session/inbox.ts), so the test counts distinct ids.
//
// The steps: before-store (the answer is not stored yet), after-store (stored, nothing sent), letter (sending),
// after-letter (the letter went, the sheet not told), close (writing the close).
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { Console, Effect, Layer, Option, Ref, Schema } from "effect"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { KV } from "@opencode/core/kv"
import { storage as hostStorage } from "@opencode/core/plugin/host"
import { DigestLog, encodeLine } from "@dotfiles/opencode-digest/event"
import * as Model from "../model.ts"
import { Changes, Courier, Family } from "../service.ts"
import * as OpenCodeStore from "./store.ts"

export const SESSION = "ses_crash0001"
export const STEPS = ["before-store", "after-store", "letter", "after-letter", "close"] as const
export type Step = (typeof STEPS)[number]
export const LETTERS = "letters.jsonl"
export const DIGEST = "digest.jsonl"

/** A letter as the file keeps it. */
export const Letter = Schema.Struct({ sessionID: Schema.String, delivery: Schema.String, text: Schema.String })
const encodeLetter = Schema.encodeSync(Schema.fromJsonString(Letter))
const encodeOpen = Schema.encodeSync(Schema.fromJsonString(Schema.Struct({ open: Schema.Boolean })))

const PORT = { question: "Which port?", header: "Port", options: [{ label: "8080" }, { label: "3000" }], assume: "8080" }

/** The process ends here, as a kill -9 would end it, when `step` is the one asked for. */
const killedAt = (asked: Option.Option<Step>, step: Step) =>
  Effect.sync(() => void Option.map(Option.filter(asked, (each) => each === step), () => process.kill(process.pid, "SIGKILL")))

/** Whether a stored sheet holds q1 still: a sheet without it is the close. */
const holdsQ1 = (value: Schema.Json) => encodeJson(value).includes('"id":"q1"')
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** The plugin's storage over the real table, killed at the store steps. */
const storageOf = (kv: KV.Interface, step: Option.Option<Step>): OpenCodeStore.Storage => {
  const real = hostStorage(kv, "questions")
  return {
    ...real,
    setIf: (key, value, rev) =>
      Effect.gen(function* () {
        const closing = !holdsQ1(value)
        const answering = encodeJson(value).includes('"answered"') && !closing
        if (closing) yield* killedAt(step, "close")
        if (answering) yield* killedAt(step, "before-store")
        const wrote = yield* real.setIf(key, value, rev)
        if (answering && wrote) yield* killedAt(step, "after-store")
        return wrote
      }),
  }
}

const modelOf = (dir: string, step: Option.Option<Step>) =>
  Layer.unwrap(
    Effect.map(KV.Service, (kv) =>
      Model.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            OpenCodeStore.layer(storageOf(kv, step)),
            Layer.effect(
              Courier,
              Effect.map(Ref.make(0), (minted) => {
                const keep = (sessionID: string, delivery: string, letter: { readonly text: string }) =>
                  Effect.sync(() => appendFileSync(join(dir, LETTERS), `${encodeLetter({ sessionID, delivery, text: letter.text })}\n`))
                return Courier.of({
                  newDelivery: Effect.map(Ref.updateAndGet(minted, (count) => count + 1), (count) => `msg_${process.pid}_${String(count).padStart(8, "0")}`),
                  deliver: (sessionID, delivery, letter) => killedAt(step, "letter").pipe(Effect.andThen(keep(sessionID, delivery, letter)), Effect.andThen(killedAt(step, "after-letter"))),
                  notify: keep,
                })
              }),
            ),
            Layer.succeed(Family, Family.of({ info: (id) => Effect.succeed({ id }) })),
            Layer.succeed(DigestLog, DigestLog.of({ append: (event) => Effect.sync(() => appendFileSync(join(dir, DIGEST), `${encodeLine(event)}\n`)) })),
            Layer.succeed(Changes, Changes.of({ changed: () => Effect.void })),
          ),
        ),
      ),
    ),
  )

/** One process's part. */
export const crash = (mode: "setup" | "answer" | "resend" | "check", db: string, dir: string, step: Option.Option<Step>) => {
  const kv = AppNodeBuilder.build(KV.node, [Database.node.replace(Database.configured({ path: db }))])
  return Effect.gen(function* () {
    const questions = yield* Model.QuestionsModel
    if (mode === "setup") return yield* Effect.asVoid(questions.ask(SESSION, { questions: [PORT] }))
    if (mode === "answer") return yield* Effect.asVoid(questions.answer(SESSION, [{ id: "q1", answer: "3000" }], [], Option.none(), "page"))
    if (mode === "resend") return yield* Effect.asVoid(Effect.andThen(questions.resend, questions.resend))
    const open = yield* questions.open([SESSION])
    yield* Console.log(encodeOpen({ open: open.some((question) => question.id === "q1") }))
  }).pipe(Effect.provide(modelOf(dir, step).pipe(Layer.provide(kv))))
}

const Args = Schema.Tuple([Schema.Literals(["setup", "answer", "resend", "check"]), Schema.String, Schema.String, Schema.optional(Schema.Literals(STEPS))])

if (import.meta.main)
  Effect.runFork(
    Effect.gen(function* () {
      const [mode, db, dir, step] = yield* Schema.decodeUnknownEffect(Args)(Bun.argv.slice(2))
      yield* crash(mode, db, dir, Option.fromUndefinedOr(step))
    }).pipe(Effect.orDie),
  )
