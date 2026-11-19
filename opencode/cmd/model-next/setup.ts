/**
 * The queued switch's TUI half, apart from the JSX entry (tui.tsx), for the
 * seam test. Two ways in, one rule behind them (the server's `queue` RPC):
 *
 * - `/model-next`: the session on screen's catalog models, then the variant
 *   when the model offers any. With a switch queued, its first option is
 *   `Cancel the queued switch`. The footer's `compact now` queues the
 *   highlighted model and asks the host for a compaction, so the outgoing
 *   model writes the summary and the next request is the new model's.
 * - The host's model picker gets the action `at next compaction` on the
 *   highlighted model (`ui.modelPickerAction`), which queues it the same way.
 *
 * Every answer is a toast in plain words; a refusal says why. The host's
 * dialogs and client are promises; each runs here as an Effect, one per key.
 */
import { Answer, label, MODEL_NEXT, type ModelRef, pendingIn, refOf, refusalText } from "@dotfiles/opencode-model-next/pending"
import type { Plugin } from "@opencode/plugin/tui"
import { Array as Arr, Effect, Match, Option, Schema } from "effect"

/** The plugin's options: `bind`, the picker action's key. */
export const Options = Schema.Struct({ bind: Schema.optional(Schema.String) })

/** The picker action's key when the options name none: free in the host's picker and its select dialog. */
export const BIND = "ctrl+g"
/** The `/model-next` dialog's `compact now` key. */
export const COMPACT_BIND = "ctrl+o"

const decodeAnswer = Schema.decodeUnknownEffect(Answer)
const readOptions = Schema.decodeUnknownOption(Options)

/** What `/model-next` offers: cancelling the queued switch, or a model. */
type Choice = { readonly kind: "cancel" } | { readonly kind: "model"; readonly model: ModelRef }
const CANCEL: Choice = { kind: "cancel" }

/** A model as the host's catalog and picker name it. */
interface Listed {
  readonly providerID: string
  readonly id: string
}

/** The toast for an answer: a refusal names the model it refused, when there is one. */
export const answerText = (answer: Answer, model: Option.Option<ModelRef>): string =>
  Match.valueTags(answer, {
    Queued: (queued) => `${label(queued.model)} queued: it takes over at the next compaction, or once the cache has expired`,
    Cancelled: (cancelled) => Match.value(cancelled.had).pipe(Match.when(true, () => "The queued switch is cancelled"), Match.orElse(() => "No switch was queued")),
    Refused: (refused) => `Not queued${Option.match(model, { onNone: () => "", onSome: (ref) => ` (${label(ref)})` })}: ${refusalText(refused.reason)}`,
  })

/** The toast's kind for an answer. */
const variantOf = (answer: Answer) => Match.valueTags(answer, { Queued: () => "info" as const, Cancelled: () => "info" as const, Refused: () => "warning" as const })

class Unanswered extends Schema.TaggedError<Unanswered>()("Unanswered", { message: Schema.String }) {}

export const setup = (ctx: Plugin.Context) => {
  const bind = Option.getOrElse(
    Option.flatMap(readOptions(ctx.options), (options) => Option.fromUndefinedOr(options.bind)),
    () => BIND,
  )
  const toast = (message: string, variant: "info" | "warning" | "error") => Effect.sync(() => ctx.ui.toast.show({ message, variant }))

  const sessionOnScreen = Effect.sync(() => {
    const route = ctx.ui.router.current()
    return Option.map(Option.liftPredicate(route, (shown) => shown.type === "session"), (shown) => shown.sessionID)
  })

  /** The model-next server's answer to `method`: a failure when it does not answer, or not as an answer. */
  const call = (method: "queue" | "cancel", input: { readonly sessionID: string; readonly model?: ModelRef }) =>
    Effect.tryPromise({
      try: () => ctx.client.rpc(MODEL_NEXT)[method](input, { location: ctx.location }),
      catch: (cause) => new Unanswered({ message: String(cause) }),
    }).pipe(Effect.flatMap((answer) => decodeAnswer(answer).pipe(Effect.mapError((error) => new Unanswered({ message: error.message })))))

  /** Queues the model and toasts the answer: whether it is queued. */
  const queue = (sessionID: string, model: ModelRef) =>
    call("queue", { sessionID, model }).pipe(
      Effect.tap((answer) => toast(answerText(answer, Option.some(model)), variantOf(answer))),
      Effect.map((answer) => answer._tag === "Queued"),
      Effect.catchTag("Unanswered", () => toast("The model-next server did not answer: is its server plugin loaded?", "error").pipe(Effect.as(false))),
    )

  /** The models the session's location offers. */
  const modelsOf = (sessionID: string) =>
    Effect.sync(() => {
      const session = Option.fromUndefinedOr(ctx.data.session.get(sessionID))
      return Option.getOrElse(Option.fromUndefinedOr(ctx.data.location.model.list(Option.getOrUndefined(Option.map(session, (found) => found.location)))), () => [])
    })

  /** The variant to queue at, when the model offers any: the mod's own dialog. None when the owner closes it. */
  const withVariant = (sessionID: string, model: Listed) =>
    Effect.gen(function* () {
      const listed = Arr.findFirst(yield* modelsOf(sessionID), (entry) => entry.providerID === model.providerID && entry.id === model.id)
      const variants = Arr.filter(
        Arr.map(Option.getOrElse(Option.map(listed, (entry) => entry.variants), () => []), (variant) => variant.id),
        (id) => id !== "default",
      )
      if (!Arr.isReadonlyArrayNonEmpty(variants)) return Option.some(refOf(model.providerID, model.id, Option.none()))
      const picked = yield* Effect.promise(() =>
        ctx.ui.dialog.select<string>({
          title: `${model.id}: which variant`,
          options: Arr.map(["default", ...variants], (id) => ({ title: id, value: id })),
        }),
      )
      return Option.map(Option.fromUndefinedOr(picked), (id) => refOf(model.providerID, model.id, Option.some(id)))
    })

  /** Asks for a compaction now: the outgoing model writes the summary, and the switch applies as it ends. */
  const compactNow = (sessionID: string) =>
    Effect.tryPromise({ try: () => ctx.client.session.compact({ sessionID }), catch: (cause) => new Unanswered({ message: String(cause) }) }).pipe(
      Effect.andThen(toast("Compacting: the outgoing model writes the summary", "info")),
      Effect.catchTag("Unanswered", (error) => toast(`The compaction did not start: ${error.message}`, "error")),
    )

  /** Queues the model at the variant the owner picks; with `compact`, compacts once it is queued. */
  const queueAt = (sessionID: string, model: Listed, compact: boolean) =>
    Effect.gen(function* () {
      const ref = yield* withVariant(sessionID, model)
      if (Option.isNone(ref)) return
      const queued = yield* queue(sessionID, ref.value)
      if (queued && compact) yield* compactNow(sessionID)
    })

  const cancel = (sessionID: string) =>
    call("cancel", { sessionID }).pipe(
      Effect.flatMap((answer) => toast(answerText(answer, Option.none()), variantOf(answer))),
      Effect.catchTag("Unanswered", () => toast("The model-next server did not answer", "error")),
    )

  const open = Effect.gen(function* () {
    const found = yield* sessionOnScreen
    if (Option.isNone(found)) return yield* toast("model-next: open a session first", "warning")
    const sessionID = found.value
    const pending = Option.flatMap(Option.fromUndefinedOr(ctx.data.session.get(sessionID)), pendingIn)
    const models = yield* modelsOf(sessionID)
    const choices = [
      ...Option.toArray(Option.map(pending, (queued) => ({ title: "Cancel the queued switch", value: CANCEL, description: label(queued.model) }))),
      ...Arr.map(models, (model) => ({
        title: model.name || model.id,
        value: { kind: "model", model: refOf(model.providerID, model.id, Option.none()) } satisfies Choice,
        description: `${model.providerID}/${model.id}`,
        category: model.providerID,
      })),
    ]
    const picked = yield* Effect.promise(() =>
      ctx.ui.dialog.select<Choice>({
        title: "Switch the model at the next compaction",
        placeholder: "Search models",
        options: choices,
        actions: [
          {
            bind: COMPACT_BIND,
            title: "compact now",
            onTrigger: (choice: Choice) => {
              if (choice.kind === "cancel") return
              ctx.ui.dialog.clear()
              Effect.runFork(queueAt(sessionID, choice.model, true))
            },
          },
        ],
      }),
    )
    return yield* Option.match(Option.fromUndefinedOr(picked), {
      onNone: () => Effect.void,
      onSome: (choice) => Match.value(choice).pipe(
        Match.when({ kind: "cancel" }, () => cancel(sessionID)),
        Match.when({ kind: "model" }, (chosen) => queueAt(sessionID, chosen.model, false)),
        Match.exhaustive,
      ),
    })
  })

  ctx.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "dotfiles-opencode.model-next.open",
        title: "Switch the model at the next compaction",
        description: "Queue a model for this session: it takes over after the next compaction, or once its prompt cache has expired",
        group: "Session",
        palette: true,
        slash: { name: "model-next" },
        run: () => {
          Effect.runFork(open)
        },
      },
    ],
  }))

  return ctx.ui.modelPickerAction({
    id: "at-next-compaction",
    bind,
    title: "at next compaction",
    onTrigger: (model) => {
      Effect.runFork(
        Effect.gen(function* () {
          const found = yield* sessionOnScreen
          if (Option.isNone(found)) return yield* toast("model-next: open a session first", "warning")
          ctx.ui.dialog.clear()
          yield* queueAt(found.value, { providerID: model.providerID, id: model.modelID }, false)
        }),
      )
    },
  })
}
