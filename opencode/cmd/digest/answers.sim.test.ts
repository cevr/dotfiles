// One question, answered from the tray and from the digest page, on the simulated host at the runner's seeds: the
// questions plugin loaded for two directories (two copies over one storage, as OpenCode serves a plugin once per
// directory), and the digest plugin, its page's handlers captured as the listener would get them (server.ts `make`).
// The tray answers as the TUI does, through the /answer form (`form.replied`); the page through its answer handler,
// which calls the questions plugin's `answer` RPC.
//
// In every order (tray then page, page then tray, both at once, and each of the first two with a server restart
// between), there is one closed question:
// - the asking session holds exactly one answer letter;
// - the digest log holds exactly one Answered line, with that answer and where it was given;
// - the page shows the same: the question is no longer open, and its decision names the answer and where;
// - the second answer changes nothing: the page's is told "already answered" with the first answer, where and when;
//   the tray's finds the question gone from its list.
import { describe } from "bun:test"
import { Array as Arr, Effect, Match, Option, Predicate, Ref, Schema } from "effect"
import { AnswerOutcome, type PageAnswer } from "@dotfiles/opencode-digest/answers"
import { decodeLine, DigestEvent, encodeLine, VERSION } from "@dotfiles/opencode-digest/event"
import type { Answered as AnsweredLine } from "@dotfiles/opencode-digest/fold"
import type * as Listener from "@dotfiles/opencode-digest/http/listener"
import * as MemoryDigest from "@dotfiles/opencode-digest/memory/log"
import { formOf } from "@dotfiles/opencode-questions/form"
import { Question, QUESTIONS } from "@dotfiles/opencode-questions/question"
import { make as makeDigest } from "./server.ts"
import { scratch } from "../../tests/scratch.ts"
import * as Plugins from "../../sim/plugins.ts"
import { plain } from "../../sim/runtime.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/digest/answers.sim.test.ts")

const ASKING = "/scratch/asking"
const SERVING = "/scratch/serving"
const SETTLE_MS = 5_000
const QUESTION = { question: "Keep the old export for one more release?", options: [{ label: "Keep it" }, { label: "Cut it" }], assume: "Keep it" }
const TRAY = "Keep it"
const PAGE = "Cut it"

const ORDERS = ["tray-page", "page-tray", "both", "tray-restart-page", "page-restart-tray"] as const
type Order = (typeof ORDERS)[number]

const Open = Schema.Struct({ questions: Schema.Array(Question) })
/** An answer letter as the asking session holds it (a notice to a root is not one). */
const Letter = Schema.Struct({
  type: Schema.Literal("synthetic"),
  metadata: Schema.Struct({
    source: Schema.Literal("questions"),
    notice: Schema.optional(Schema.Unknown),
    answers: Schema.Array(Schema.Struct({ id: Schema.String, answer: Schema.String })),
  }),
})
/** The parts of the page's view this test reads. */
const View = Schema.fromJsonString(
  Schema.Struct({
    projects: Schema.Array(
      Schema.Struct({
        inbox: Schema.Array(
          Schema.Struct({ id: Schema.String, open: Schema.Boolean, decided: Schema.optional(Schema.Array(Schema.Struct({ said: Schema.String, via: Schema.optional(Schema.String) }))) }),
        ),
      }),
    ),
  }),
)

/** The page's handlers, the latest copy's (a restart builds them again). */
const handlersOf = (captured: Ref.Ref<Option.Option<Listener.Handlers>>) =>
  Effect.flatMap(Ref.get(captured), (found) => Option.match(found, { onNone: () => Effect.die("the digest's page was never started"), onSome: Effect.succeed }))

/**
 * The tray: he opens /answer over the session's open questions (none open: no form); its submit, answering TRAY,
 * is the effect it gives, so a test may race the submit alone.
 */
const openTray = (world: World.World, root: string) =>
  Effect.gen(function* () {
    const open = Schema.decodeUnknownSync(Open)(yield* world.rpc(QUESTIONS.id, "open", { sessionIDs: [root] }))
    return yield* Option.match(Option.fromUndefinedOr(formOf(open.questions, root)), {
      onNone: () => Effect.succeed(Effect.void),
      onSome: (input) => Effect.map(world.form.create(root, input), (form) => world.form.reply(form, Object.fromEntries(input.fields.map((field) => [field.key, TRAY])))),
    })
  })

const run = (seed: number, order: Order, dir: string) =>
  Effect.gen(function* () {
    const world = World.make({ seed, script: (request) => World.say(`turn of ${request.sessionID}`) })
    const memory = MemoryDigest.empty()
    const captured = yield* Ref.make(Option.none<Listener.Handlers>())
    const digest = makeDigest(() => MemoryDigest.layer(memory), (_options, given) => Ref.set(captured, Option.some(given)))
    // The digest's marks and pairing files go in the test's own folder, never the host's.
    yield* world.load(digest, { directory: SERVING, options: { dir } })
    yield* world.load(Plugins.questions, { directory: SERVING })
    yield* world.load(Plugins.questions, { directory: ASKING })
    const root = yield* world.session(ASKING, { title: "Release" })
    yield* Ref.update(memory.lines, (lines) => [
      ...lines,
      encodeLine(DigestEvent.cases.Run.make({ v: VERSION, t: 1, root, host: "sim", repo: "demo", dir: Option.none(), name: Option.some("Release") })),
    ])
    yield* world.tool(root, "ask_user_async", { questions: [QUESTION] })
    yield* world.advance(SETTLE_MS)
    const outcome = yield* Ref.make(Option.none<AnswerOutcome>())
    const input: PageAnswer = { id: `question:${root}:q1`, option: PAGE }
    const page = Effect.flatMap(handlersOf(captured), (handlers) => Effect.flatMap(handlers.answer(input), (each) => Ref.set(outcome, Option.some(each))))
    const fromTray = Effect.flatMap(openTray(world, root), (submit) => submit)
    // His /answer form open since before the page's answer, he submits it in the same instant: no time passes between.
    const both = Effect.flatMap(openTray(world, root), (submit) => Effect.andThen(submit, page))
    const settle = world.advance(SETTLE_MS)
    const steps: Record<Order, ReadonlyArray<Effect.Effect<void, unknown>>> = {
      "tray-page": [fromTray, settle, page],
      "page-tray": [page, settle, fromTray],
      both: [both],
      "tray-restart-page": [fromTray, settle, world.restart, settle, page],
      "page-restart-tray": [page, settle, world.restart, settle, fromTray],
    }
    for (const step of steps[order]) yield* step
    yield* world.advance(60_000)
    const letters = world
      .messages(root)
      .flatMap((message) => Option.toArray(Schema.decodeUnknownOption(Letter)(plain(message))))
      .filter((letter) => Predicate.isUndefined(letter.metadata.notice))
      .flatMap((letter) => letter.metadata.answers)
    const lines = (yield* Ref.get(memory.lines)).flatMap((line) =>
      Option.toArray(Option.flatMap(decodeLine(line), (event) => Option.liftPredicate(event, (each): each is AnsweredLine => each._tag === "Answered"))),
    )
    const view = Schema.decodeUnknownSync(View)(yield* (yield* handlersOf(captured)).view)
    const open = Schema.decodeUnknownSync(Open)(yield* world.rpc(QUESTIONS.id, "open", { sessionIDs: [root] }))
    return { letters, lines, view, open, outcome: yield* Ref.get(outcome) }
  })

describe("one question answered from the tray and the page", () => {
  for (const order of ORDERS)
    seeded(`${order}: closed once, one letter, one Answered line; the page and the loser show the first answer and where`, ({ seed, expect }) =>
      Effect.gen(function* () {
        using held = scratch("digest-answers-")
        const { letters, lines, view, open, outcome } = yield* run(seed, order, `${held.path}/digest`)
        expect(letters).toHaveLength(1)
        expect(lines).toHaveLength(1)
        const line = Option.getOrThrow(Arr.head(lines))
        const via = Option.getOrElse(line.via, () => "none")
        // The first answer is the one everything shows: the letter, the line, its place.
        const first = Match.value(via).pipe(
          Match.when("page", () => PAGE),
          Match.when("tray", () => TRAY),
          Match.orElse(() => "neither surface"),
        )
        expect([...letters.map((letter) => letter.answer), line.answer]).toEqual([first, first])
        // The page agrees: nothing open, and its decision names the answer and where.
        const inbox = view.projects.flatMap((project) => project.inbox)
        expect(inbox.filter((message) => message.open)).toEqual([])
        expect(inbox.flatMap((message) => Option.getOrElse(Option.fromUndefinedOr(message.decided), () => []))).toEqual([{ said: first, via }])
        expect(open.questions).toEqual([])
        // The page's own answer: sent when it was first, else told the first answer, where and when.
        const expected = Match.value(via).pipe(
          Match.when("page", () => AnswerOutcome.Answered({ replaced: Option.none() })),
          Match.orElse(() => AnswerOutcome.AlreadyClosed({ answer: Option.some(TRAY), via: Option.some("tray"), at: Option.some(line.t) })),
        )
        expect(outcome).toEqual(Option.some(expected))
      }),
    )
})
