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
import { Context, Effect, Layer, Ref, Schema, Stream } from "effect"
import { AskInput, DESCRIPTION, explain, NAME, receipt } from "@dotfiles/opencode-questions/ask"
import * as Model from "@dotfiles/opencode-questions/model"
import * as OpenCodeCourier from "@dotfiles/opencode-questions/opencode/courier"
import * as OpenCodeFamily from "@dotfiles/opencode-questions/opencode/family"
import * as OpenCodeStore from "@dotfiles/opencode-questions/opencode/store"
import { replyOf } from "@dotfiles/opencode-questions/form"
import { Given, type Open, QUESTIONS, type Rejection, type Reply } from "@dotfiles/opencode-questions/question"
import { Changes, type Courier, type DeliveryRefused, type Family, type QuestionStore, type QuestionsUnreadable } from "@dotfiles/opencode-questions/service"

/** The live externals: the plugin's storage, the session inbox, and who each session is. */
export const live = (ctx: Plugin.Context): Layer.Layer<QuestionStore | Courier | Family> =>
  Layer.mergeAll(OpenCodeStore.fromContext(ctx), OpenCodeCourier.fromContext(ctx), OpenCodeFamily.fromContext(ctx))

/** What the agent or the user reads when a call fails. */
const messageOf = (failure: Rejection | QuestionsUnreadable | DeliveryRefused) => {
  if (failure._tag === "QuestionsUnreadable") return `The questions could not be read: ${failure.message}`
  if (failure._tag === "DeliveryRefused")
    return failure.gone ? "The session that asked is gone." : `The answer is saved and goes when the session takes it: ${failure.message}`
  return explain(failure)
}

const OpenInput = Schema.Struct({ sessionIDs: Schema.Array(Schema.String) })
const AnswerInput = Schema.Struct({ sessionID: Schema.String, answers: Schema.Array(Given) })
const DismissInput = Schema.Struct({ sessionID: Schema.String, id: Schema.String })

const done: Reply = { ok: true }
const refused = (failure: Rejection | QuestionsUnreadable | DeliveryRefused): Reply => ({ ok: false, message: messageOf(failure) })
const malformed = (error: Schema.SchemaError): Reply => ({ ok: false, message: `malformed request: ${error.message}` })

/** The plugin on `externals`: the plugin's storage and inbox in OpenCode, the memory doubles in the seam test. */
export const make = (externals: (ctx: Plugin.Context) => Layer.Layer<QuestionStore | Courier | Family>) =>
  Plugin.define({
    id: QUESTIONS.id,
    effect: Effect.fn("Questions.plugin")(function* (ctx) {
      // Changes are announced once the RPC is registered; one before then has no reader to tell.
      const announce = yield* Ref.make<(sessionID: string) => Effect.Effect<void>>(() => Effect.void)
      const changes = Layer.succeed(Changes, { changed: (sessionID) => Effect.flatMap(Ref.get(announce), (emit) => emit(sessionID)) })
      const services = yield* Layer.build(Model.layer.pipe(Layer.provide(Layer.merge(externals(ctx), changes))))
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
                questions.answer(reply.sessionID, reply.answers, reply.dismissed).pipe(
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
              Effect.flatMap(({ sessionIDs }) => questions.open(sessionIDs)),
              Effect.map((open): Open => ({ questions: [...open] })),
              Effect.orElseSucceed((): Open => ({ questions: [] })),
            ),
          answer: (input) =>
            Schema.decodeUnknownEffect(AnswerInput)(input).pipe(
              Effect.matchEffect({
                onFailure: (error) => Effect.succeed(malformed(error)),
                onSuccess: ({ sessionID, answers }) =>
                  questions.answer(sessionID, answers).pipe(
                    Effect.map(({ skipped }): Reply => (skipped.length === 0 ? done : { ok: true, message: `No longer open, so not sent: ${skipped.join(", ")}.` })),
                    Effect.catch((failure) => Effect.succeed(refused(failure))),
                  ),
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
