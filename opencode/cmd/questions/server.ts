/**
 * Background questions as an OpenCode server plugin. The composition root: it
 * builds the questions model (`@dotfiles/opencode-questions/model`) on the
 * plugin's storage and the session inbox, registers the `ask_user_async` tool
 * and answers the questions RPC (`@dotfiles/opencode-questions/question`,
 * `QUESTIONS`) the tray and the /answer pane read.
 *
 * - `ask_user_async({ questions?, withdraw? })` asks in the calling session and
 *   returns at once with the ids and assumptions; the agent carries on. A
 *   subagent's questions are its own, and its answer goes to it; they show,
 *   and are answered, in the root session's tray and form with its own. A
 *   direct tool, so a kernel cell reaches it as `tools.ask_user_async(...)`.
 * - `open({ sessionIDs })`, `answer(...)`, `dismiss(...)` for the TUI; every
 *   change publishes `changed({ sessionID })`.
 * - `askFor`, `asked`, `withdrawFor` for another plugin (the pool): it asks
 *   the owner in a session under its own key, once per key; the question shows
 *   in the tray and form like the agent's, but its answer is no message: it
 *   waits on the row until the plugin reads it (`asked`, on a `changed`) and
 *   withdraws it. The agent cannot withdraw, replace or drop it.
 * - The TUI's /answer opens the host's question form, in the session on
 *   screen, for its open questions and its subagents'
 *   (`@dotfiles/opencode-questions/form`); its submit comes back as the host's
 *   `form.replied` event, and the answers each asking session was given
 *   arrive in it as one synthetic steer message that wakes it when idle. The
 *   root of a subagent's tree gets a notice of the subagent's answers, which
 *   does not wake it. ctrl+x on a tab dismisses its question (the form's one
 *   action): beside answers the message names it; alone, nothing is sent.
 *   Answers recorded but not delivered go with the session's next answer, and
 *   when the plugin starts.
 * - A deleted or archived session's questions go.
 */
import { Plugin, Tool } from "@opencode/plugin/effect"
import { Context, Effect, Layer, Match, Option, Ref, Schema, Stream } from "effect"
import { DIGEST } from "@dotfiles/opencode-digest/event"
import * as Relay from "@dotfiles/opencode-digest/relay"
import { AskedQuestion, AskInput, DESCRIPTION, explain, NAME, receipt } from "@dotfiles/opencode-questions/ask"
import * as Model from "@dotfiles/opencode-questions/model"
import * as OpenCodeCourier from "@dotfiles/opencode-questions/opencode/courier"
import * as OpenCodeFamily from "@dotfiles/opencode-questions/opencode/family"
import * as OpenCodeStore from "@dotfiles/opencode-questions/opencode/store"
import { replyOf } from "@dotfiles/opencode-questions/form"
import { AskFor, Choice, Given, Via, type Open, type PluginAsked, type Put, QUESTIONS, type Rejection, type Reply } from "@dotfiles/opencode-questions/question"
import { Changes, type Courier, type DeliveryRefused, type Family, type QuestionStore, type QuestionsUnreadable } from "@dotfiles/opencode-questions/service"

/** The live externals: the plugin's storage, the session inbox, and who each session is. */
export const live = (ctx: Plugin.Context): Layer.Layer<QuestionStore | Courier | Family, OpenCodeStore.NoConditionalWrite> =>
  Layer.mergeAll(OpenCodeStore.fromContext(ctx), OpenCodeCourier.fromContext(ctx), OpenCodeFamily.fromContext(ctx))

/** What the agent or the user reads when a call fails. */
const messageOf = (failure: Rejection | QuestionsUnreadable | DeliveryRefused) => {
  if (failure._tag === "QuestionsUnreadable") return `The questions could not be read: ${failure.message}`
  if (failure._tag === "DeliveryRefused")
    return failure.gone ? "The session that asked is gone." : `The answer is saved and goes when the session takes it: ${failure.message}`
  return explain(failure)
}

const OpenInput = Schema.Struct({ sessionIDs: Schema.Array(Schema.String) })
const AnswerInput = Schema.Struct({ sessionID: Schema.String, answers: Schema.Array(Given), via: Schema.optional(Via) })
const DismissInput = Schema.Struct({ sessionID: Schema.String, id: Schema.String })
const AskForInput = Schema.Struct({
  sessionID: Schema.String,
  plugin: Schema.String,
  key: Schema.String,
  question: Schema.String,
  header: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(Choice)),
  assume: Schema.String,
})
const PutInput = Schema.Struct({
  sessionID: Schema.String,
  to: Schema.String,
  nudge: Schema.String,
  questions: Schema.optional(Schema.Array(AskedQuestion)),
  withdraw: Schema.optional(Schema.Array(Schema.String)),
})
const ReplyInput = Schema.Struct({ by: Schema.String, answers: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })) })
const PluginInput = Schema.Struct({ plugin: Schema.String })
const WithdrawForInput = Schema.Struct({ plugin: Schema.String, key: Schema.String })

const done: Reply = { ok: true }
const refused = (failure: Rejection | QuestionsUnreadable | DeliveryRefused): Reply => ({ ok: false, message: messageOf(failure) })
/** A refusal because none of it was open any more: another answer closed it first. */
const closedOf = (failure: Rejection | QuestionsUnreadable | DeliveryRefused): Pick<Reply, "closed"> =>
  Match.value(failure).pipe(
    Match.tag("NotOpen", (): Pick<Reply, "closed"> => ({ closed: true })),
    Match.orElse(() => ({})),
  )

const malformed = (error: Schema.SchemaError): Reply => ({ ok: false, message: `malformed request: ${error.message}` })

/** The plugin on `externals`: the plugin's storage and inbox in OpenCode, the memory doubles in the seam test. */
export const make = (externals: (ctx: Plugin.Context) => Layer.Layer<QuestionStore | Courier | Family, OpenCodeStore.NoConditionalWrite>) =>
  Plugin.define({
    id: QUESTIONS.id,
    effect: Effect.fn("Questions.plugin")(function* (ctx) {
      // Changes are announced once the RPC is registered; one before then has no reader to tell.
      const announce = yield* Ref.make<(sessionID: string) => Effect.Effect<void>>(() => Effect.void)
      const changes = Layer.succeed(Changes, { changed: (sessionID) => Effect.flatMap(Ref.get(announce), (emit) => emit(sessionID)) })
      // The owner's questions go to the digest through its RPC, held while the digest plugin is not up.
      const digest = Relay.layer((line) => ctx.rpc(DIGEST).append({ line }))
      // A fork without storage.setIf cannot close a question once: the plugin does not start, and its error says why.
      const services = yield* Layer.build(Model.layer.pipe(Layer.provide(Layer.mergeAll(externals(ctx), changes, digest)))).pipe(Effect.orDie)
      const questions = Context.get(services, Model.QuestionsModel)

      yield* ctx.tool.transform((editor) => {
        editor.add({
          name: NAME,
          description: DESCRIPTION,
          input: AskInput,
          // A direct tool beside the others, so it is offered without code mode and reached from a kernel cell.
          options: { codemode: false },
          execute: (input, context) =>
            questions.ask(context.sessionID, input).pipe(
              Effect.map((asked) => ({ content: [{ type: "text" as const, text: receipt(asked) }] })),
              Effect.mapError((failure) => new Tool.Error({ message: messageOf(failure), error: failure })),
            ),
        })
      })

      // The /answer form's submit: the answers each asking session was given (the form's own session and its
      // subagents') go to it as one message, naming the questions dismissed beside them; a session given only
      // dismissals is sent nothing. The subagents' go first, and each tells the root of its tree.
      yield* Effect.forkScoped(
        ctx.event.subscribe({ types: ["form.replied"] }).pipe(
          Stream.runForEach((event) =>
            Effect.forEach(
              replyOf(event.data.answer, event.data.sessionID) ?? [],
              (reply) =>
                questions.answer(reply.sessionID, reply.answers, reply.dismissed, Option.none(), "tray").pipe(
                  Effect.catchCause((cause) => Effect.logWarning("questions: the form's answers were not recorded", { sessionID: reply.sessionID, cause })),
                ),
              { discard: true },
            ),
          ),
          Effect.ignoreCause,
        ),
      )

      // A deleted or archived (ended) session's questions go, so none lingers in its root's tray.
      yield* Effect.forkScoped(
        ctx.event.subscribe({ types: ["session.deleted", "session.archived"] }).pipe(
          Stream.runForEach((event) => questions.forget(event.data.sessionID).pipe(Effect.ignoreCause)),
          Effect.ignoreCause,
        ),
      )

      const registration = yield* ctx.rpc
        .register(QUESTIONS, {
          open: (input) =>
            Schema.decodeUnknownEffect(OpenInput)(input).pipe(
              Effect.flatMap(({ sessionIDs }) => Effect.zipWith(questions.open(sessionIDs), questions.held(sessionIDs), (open, held): Open => ({ questions: [...open], held: [...held] }))),
              Effect.orElseSucceed((): Open => ({ questions: [], held: [] })),
            ),
          put: (input) =>
            Schema.decodeUnknownEffect(PutInput)(input).pipe(
              Effect.matchEffect({
                onFailure: (error) => Effect.succeed(malformed(error)),
                onSuccess: ({ sessionID, to, nudge, ...asked }) =>
                  questions.put(sessionID, asked, to, nudge).pipe(
                    Effect.map((done): Put => ({ ok: true, opened: [...done.opened], closed: [...done.closed] })),
                    Effect.catch((failure) => Effect.succeed(refused(failure))),
                  ),
              }),
            ),
          reply: (input) =>
            Schema.decodeUnknownEffect(ReplyInput)(input).pipe(
              Effect.matchEffect({
                onFailure: (error) => Effect.succeed(malformed(error)),
                onSuccess: ({ by, answers }) =>
                  questions.reply(by, answers).pipe(
                    Effect.map((refs): Reply => ({ ok: true, message: `Answered ${refs.join(", ")}; each answer went to the subagent that asked.` })),
                    Effect.catch((failure) => Effect.succeed(refused(failure))),
                  ),
              }),
            ),
          answer: (input) =>
            Schema.decodeUnknownEffect(AnswerInput)(input).pipe(
              Effect.matchEffect({
                onFailure: (error) => Effect.succeed(malformed(error)),
                onSuccess: ({ sessionID, answers, via }) =>
                  questions.answer(sessionID, answers, [], Option.none(), via).pipe(
                    Effect.map(({ skipped }): Reply => (skipped.length === 0 ? done : { ok: true, message: `No longer open, so not sent: ${skipped.join(", ")}.` })),
                    // Another answer (the tray's, or the page's) closed it first: say so, so the caller can tell whose.
                    Effect.catch((failure) => Effect.succeed<Reply>({ ...refused(failure), ...closedOf(failure) })),
                  ),
              }),
            ),
          askFor: (input) =>
            Schema.decodeUnknownEffect(AskForInput)(input).pipe(
              Effect.matchEffect({
                onFailure: (error) => Effect.succeed(malformed(error)),
                onSuccess: ({ plugin, key, ...asked }) =>
                  questions.askFor(AskFor.make({ ...asked, from: { plugin, key } })).pipe(
                    Effect.as(done),
                    Effect.catch((failure) => Effect.succeed(refused(failure))),
                  ),
              }),
            ),
          asked: (input) =>
            Schema.decodeUnknownEffect(PluginInput)(input).pipe(
              Effect.flatMap(({ plugin }) => questions.asked(plugin)),
              Effect.map((asked): PluginAsked => ({ questions: [...asked] })),
              Effect.orElseSucceed((): PluginAsked => ({ questions: [] })),
            ),
          withdrawFor: (input) =>
            Schema.decodeUnknownEffect(WithdrawForInput)(input).pipe(
              Effect.matchEffect({
                onFailure: (error) => Effect.succeed(malformed(error)),
                onSuccess: (from) => questions.withdrawFor(from).pipe(Effect.as(done)),
              }),
            ),
          dismiss: (input) =>
            Schema.decodeUnknownEffect(DismissInput)(input).pipe(
              Effect.matchEffect({
                onFailure: (error) => Effect.succeed(malformed(error)),
                onSuccess: ({ sessionID, id }) =>
                  questions.dismiss(sessionID, id).pipe(
                    Effect.as(done),
                    Effect.catch((failure) => Effect.succeed(refused(failure))),
                  ),
              }),
            ),
        })
        .pipe(Effect.orDie)
      yield* Ref.set(announce, (sessionID) => registration.events.emit("changed", { sessionID }).pipe(Effect.ignore))

      // Answers a stopped server recorded and never sent go now, without holding up the start.
      yield* Effect.forkScoped(questions.resend.pipe(Effect.ignoreCause))
    }),
  })

export default make(live)
