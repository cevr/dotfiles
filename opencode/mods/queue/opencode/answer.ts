// Opening the answer form for a queue item (../answer.ts `formOf`) in the
// session on screen, through the host's own question form, as the questions
// mod's /answer opens its own (mods/questions/opencode/form.ts): the session
// view draws a pending form in the composer's place, and its submit is the
// host's `form.replied`, which the queue's server plugin reads. A session
// that already has one of our forms pending gets no second.
//
// `openAnswer` works on a plain view of the TUI plugin context, so its test
// runs it over a stand-in; `fromContext` takes the view from the context
// (`client.session.form.create`, POST /api/session/:id/form in the fork).
import type { Plugin } from "@opencode/plugin/tui"
import { Array as Arr, Effect, Option, Schema } from "effect"
import { type FormInput, KEY_PREFIX } from "../answer.ts"

/** The host would not open the form. */
export class FormRefused extends Schema.TaggedError<FormRefused>()("FormRefused", { sessionID: Schema.String }) {}

/** The host's forms as the Queue tab reaches them. */
export interface FormHost {
  /** The keys of the fields of each of the session's pending forms. */
  readonly pending: (sessionID: string) => ReadonlyArray<ReadonlyArray<string>>
  /** Open a form in the session. */
  readonly create: (sessionID: string, input: FormInput) => Effect.Effect<void, FormRefused>
}

/** What opening did: opened it, found one of ours pending already, or the host refused. */
export type Opened = "opened" | "already" | "failed"

/** Open `input` in session `screen`, unless one of our forms is pending there. */
export const openAnswer = (host: FormHost, screen: string, input: FormInput): Effect.Effect<Opened> =>
  Effect.suspend(() => {
    if (host.pending(screen).some((keys) => keys.some((key) => key.startsWith(KEY_PREFIX)))) return Effect.succeed<Opened>("already")
    return host.create(screen, input).pipe(
      Effect.as<Opened>("opened"),
      Effect.catchTag("FormRefused", () => Effect.succeed<Opened>("failed")),
    )
  })

/** The host's forms through the TUI plugin context. */
export const fromContext = (ctx: Plugin.Context): FormHost => ({
  pending: (sessionID) =>
    Option.getOrElse(Option.fromNullishOr(ctx.data.session.form.list(sessionID)), Arr.empty).map((form) => form.fields.map((field) => field.key)),
  create: (sessionID, input) =>
    Effect.tryPromise({
      try: () => ctx.client.session.form.create({ sessionID, title: input.title, metadata: { ...input.metadata }, fields: input.fields }),
      catch: () => new FormRefused({ sessionID }),
    }).pipe(Effect.asVoid),
})
