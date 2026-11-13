// The host's forms, as a client (the TUI's /answer) opens and answers them:
// `session.form.create` and `session.form.reply` in the fork's API
// (packages/core/src/form.ts `create`, `reply`). A form belongs to a session;
// its reply publishes `form.replied` `{ id, sessionID, answer }` and settles
// it, so a second reply is refused, as one to a form the host does not have.
// The event is heard in the location of the form's session (sim/locations.ts),
// as the HTTP route that replies runs in it.
//
// Not modelled: the fork's validation of the fields and of an answer against
// them (`validateFields`, `validateAnswer`), and `form.created` and
// `form.cancelled`; no plugin of ours reads them. The world's tests send
// the answers the TUI's form would.
import { Data, Effect, Option, type Schema } from "effect"
import type { Host } from "./host.ts"
import type { JsonObject } from "./runtime.ts"

/** A form the host has no record of, or one already answered. */
export class FormRefused extends Data.TaggedError("FormRefused")<{ readonly message: string }> {}

/** What `session.form.create` takes, but the session: the form's title and fields as the client sends them. */
export interface FormInput {
  readonly title: string
  readonly fields: ReadonlyArray<{ readonly key: string }>
}

interface Form {
  readonly id: string
  readonly sessionID: string
  /** The location of its session: where its reply is heard, the session gone or not. */
  readonly directory: string
  readonly keys: ReadonlyArray<string>
  answered: boolean
}

/** The forms of one host. */
export const make = (host: Host) => {
  const forms = new Map<string, Form>()

  /** Opens a form in a session: its id. */
  const create = (sessionID: string, input: FormInput) =>
    Effect.gen(function* () {
      const session = yield* host.sessionOr(sessionID)
      const id = host.mint("frm_")
      forms.set(id, { id, sessionID: session.id, directory: session.directory, keys: input.fields.map((field) => field.key), answered: false })
      host.record("form-created", { formID: id, sessionID: session.id, keys: input.fields.map((field) => field.key) })
      return id
    })

  /** Answers a form: `form.replied` in its session's location, and the form is settled. */
  const reply = (formID: string, answer: { readonly [key: string]: Schema.Json }) =>
    Effect.gen(function* () {
      const form = yield* Effect.fromOption(Option.fromNullishOr(forms.get(formID))).pipe(
        Effect.mapError(() => new FormRefused({ message: `no form ${formID}` })),
      )
      if (form.answered) return yield* new FormRefused({ message: `the form ${formID} is already answered` })
      form.answered = true
      const data: JsonObject = { id: form.id, sessionID: form.sessionID, answer }
      yield* host.publish({ type: "form.replied", data }, form.directory)
    })

  return { create, reply }
}
