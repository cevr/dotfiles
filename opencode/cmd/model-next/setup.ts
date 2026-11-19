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
 * Every answer is a toast in plain words; a refusal says why.
 */
import { Answer, label, MODEL_NEXT, type ModelRef, pendingOf, refusalText } from "@dotfiles/opencode-model-next/pending"
import type { Plugin } from "@opencode/plugin/tui"
import { Option, Schema } from "effect"

/** The plugin's options: `bind`, the picker action's key. */
export const Options = Schema.Struct({ bind: Schema.optional(Schema.String) })

/** The picker action's key when the options name none: free in the host's picker and its select dialog. */
export const BIND = "ctrl+g"
/** The `/model-next` dialog's `compact now` key. */
export const COMPACT_BIND = "ctrl+o"

const decodeAnswer = Schema.decodeUnknownOption(Answer)

type Choice = { readonly kind: "cancel" } | { readonly kind: "model"; readonly model: ModelRef }

/** The toast for an answer. */
export const answerText = (answer: Answer, model?: ModelRef): string => {
  if (answer._tag === "Queued") return `${label(answer.model)} queued: it takes over at the next compaction, or once the cache has expired`
  if (answer._tag === "Cancelled") return answer.had ? "The queued switch is cancelled" : "No switch was queued"
  return `Not queued${model === undefined ? "" : ` (${label(model)})`}: ${refusalText(answer.reason)}`
}

export const setup = (ctx: Plugin.Context) => {
  const options = Option.getOrElse(Schema.decodeUnknownOption(Options)(ctx.options ?? {}), () => ({ bind: undefined }))
  const toast = (message: string, variant: "info" | "warning" | "error" = "info") => ctx.ui.toast.show({ message, variant })

  const sessionOnScreen = () => {
    const route = ctx.ui.router.current()
    return route.type === "session" ? Option.some(route.sessionID) : Option.none<string>()
  }

  const call = async (method: "queue" | "cancel", input: Record<string, unknown>): Promise<Answer | undefined> =>
    ctx.client
      .rpc(MODEL_NEXT)
      [method](input, { location: ctx.location })
      .then((answer: unknown) => Option.getOrUndefined(decodeAnswer(answer)), () => undefined)

  const queue = async (sessionID: string, model: ModelRef): Promise<boolean> => {
    const answer = await call("queue", { sessionID, model })
    if (answer === undefined) {
      toast("The model-next server did not answer: is its server plugin loaded?", "error")
      return false
    }
    toast(answerText(answer, model), answer._tag === "Refused" ? "warning" : "info")
    return answer._tag === "Queued"
  }

  /** The variant to queue at, when the model offers any: the mod's own dialog. Undefined when the owner closes it. */
  const variantOf = async (sessionID: string, model: { readonly providerID: string; readonly id: string }): Promise<ModelRef | undefined> => {
    const session = ctx.data.session.get(sessionID)
    const info = ctx.data.location.model.list(session?.location)?.find((entry) => entry.providerID === model.providerID && entry.id === model.id)
    const variants = info?.variants ?? []
    if (variants.length === 0) return { providerID: model.providerID, id: model.id }
    const picked = await ctx.ui.dialog.select<string>({
      title: `${model.id}: which variant`,
      options: [{ title: "default", value: "default" }, ...variants.filter((variant) => variant.id !== "default").map((variant) => ({ title: variant.id, value: variant.id }))],
    })
    if (picked === undefined) return undefined
    return { providerID: model.providerID, id: model.id, ...(picked === "default" ? {} : { variant: picked }) }
  }

  const queueWithVariant = async (sessionID: string, model: { readonly providerID: string; readonly id: string }, then?: () => Promise<void>) => {
    const ref = await variantOf(sessionID, model)
    if (ref === undefined) return
    if ((await queue(sessionID, ref)) && then !== undefined) await then()
  }

  const compactNow = (sessionID: string) => async () => {
    await ctx.client.session.compact({ sessionID }).then(
      () => toast("Compacting: the outgoing model writes the summary"),
      (error: unknown) => toast(`The compaction did not start: ${String(error)}`, "error"),
    )
  }

  const open = async () => {
    const found = sessionOnScreen()
    if (Option.isNone(found)) return toast("model-next: open a session first", "warning")
    const sessionID = found.value
    const session = ctx.data.session.get(sessionID)
    const pending = pendingOf(sessionID, session?.metadata)
    const models = ctx.data.location.model.list(session?.location) ?? []
    const choices: Array<{ readonly title: string; readonly value: Choice; readonly description?: string; readonly category?: string }> = [
      ...Option.match(pending, {
        onNone: () => [],
        onSome: (queued) => [{ title: "Cancel the queued switch", value: { kind: "cancel" } as const, description: label(queued.model) }],
      }),
      ...models.map((model) => ({
        title: model.name || model.id,
        value: { kind: "model", model: { providerID: model.providerID, id: model.id } } as const,
        description: `${model.providerID}/${model.id}`,
        category: model.providerID,
      })),
    ]
    const picked = await ctx.ui.dialog.select<Choice>({
      title: "Switch the model at the next compaction",
      placeholder: "Search models",
      options: choices,
      actions: [
        {
          bind: COMPACT_BIND,
          title: "compact now",
          onTrigger: (choice: Choice) => {
            if (choice.kind !== "model") return
            ctx.ui.dialog.clear()
            void queueWithVariant(sessionID, choice.model, compactNow(sessionID))
          },
        },
      ],
    })
    if (picked === undefined) return
    if (picked.kind === "cancel") {
      const answer = await call("cancel", { sessionID })
      return toast(answer === undefined ? "The model-next server did not answer" : answerText(answer), answer === undefined ? "error" : "info")
    }
    await queueWithVariant(sessionID, picked.model)
  }

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
        run: () => void open(),
      },
    ],
  }))

  return ctx.ui.modelPickerAction({
    id: "at-next-compaction",
    bind: options.bind ?? BIND,
    title: "at next compaction",
    onTrigger: (model) => {
      const found = sessionOnScreen()
      if (Option.isNone(found)) return toast("model-next: open a session first", "warning")
      ctx.ui.dialog.clear()
      void queueWithVariant(found.value, { providerID: model.providerID, id: model.modelID })
    },
  })
}
