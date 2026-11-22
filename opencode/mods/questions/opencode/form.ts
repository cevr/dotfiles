// /answer through the host's question form: one form, in the session on
// screen, for the open questions its tray shows (its own and its subagents',
// at any depth), so the owner answers a subagent's question where they look,
// as they answer the session's own. The host's session view shows a pending
// form in the composer's place, exactly as it shows the built-in `question`
// tool's. A session that already has one of our forms pending gets no second.
//
// Opening is idempotent and never stale (`opener`): while an open of a
// session is under way (its questions read, its form made and listed),
// another click, /answer or shift+← does nothing more; once our form is
// listed they find it there. The form is built from the questions read from
// the server at that moment, never from the tray's last reading, so questions
// answered meanwhile (in this form, on the digest page, in another TUI) are
// never shown again; a read with none open opens nothing. A form of ours
// still pending whose questions all closed is cancelled, not shown.
// (2026-11-21: on a server under contention each of N clicks made a form, and
// the host showed them one after another, the answered questions N-1 times.)
//
// `opener` works on a plain view of the TUI plugin context, so the seam test
// runs it over a stand-in; `fromContext` takes the view from the context.
//
// Where it lives, in the fork: `client.session.form.create` (POST
// /api/session/:id/form, packages/server/src/handlers/session.ts
// "session.form.create") makes a `Form.Info` the core's Form service keeps in
// memory and announces as `form.created`; the TUI's data store lists it under
// its session (packages/client/src/solid/data.ts), and the session route
// draws the first pending form of the session and its subagents with
// `FormPrompt` (packages/tui/src/routes/session/index.tsx, form.tsx). Its
// submit is `form.replied`, which the server plugin reads.
import type { Plugin } from "@opencode/plugin/tui"
import { Array as Arr, Effect, Option, Schema } from "effect"
import { askerOf } from "../asker.ts"
import { type FormInput, formOf, isOurs, KEY_PREFIX } from "../form.ts"
import { type Question, QUESTIONS } from "../question.ts"
import { decodeOpen } from "../reading.ts"
import { under } from "../tray.ts"

/** The host would not make the form. */
export class FormRefused extends Schema.TaggedError<FormRefused>()("FormRefused", { sessionID: Schema.String }) {}

/** The session's open questions could not be read from the server. */
export class QuestionsUnread extends Schema.TaggedError<QuestionsUnread>()("QuestionsUnread", { sessionID: Schema.String }) {}

/** A pending host form, as far as /answer reads it. */
export interface PendingForm {
  readonly id: string
  readonly fields: ReadonlyArray<{ readonly key: string }>
}

/** The host as /answer reaches it. */
export interface FormHost {
  /** The session's pending forms, as the TUI lists them. */
  readonly pending: (sessionID: string) => ReadonlyArray<PendingForm>
  /** The open questions the session's tray shows (its own and its subagents'), read from the server now. */
  readonly read: (sessionID: string) => Effect.Effect<ReadonlyArray<Question>, QuestionsUnread>
  /** Open a form in the session. */
  readonly create: (sessionID: string, input: FormInput) => Effect.Effect<void, FormRefused>
  /** Read the session's pending forms from the server again, so one just made is listed. */
  readonly refresh: (sessionID: string) => Effect.Effect<void>
  /** Cancel a pending form of the session. */
  readonly cancel: (sessionID: string, formID: string) => Effect.Effect<void>
  /** Who a session is, to name the asker. */
  readonly asker: (sessionID: string) => string
}

/**
 * What one open did:
 * - `opened`: a form was made for the questions open now;
 * - `already`: one of ours is pending there, or an open of the session is under way;
 * - `none`: no question is open now;
 * - `unread`: the questions could not be read, so nothing opened;
 * - `failed`: the host would not make the form.
 */
export type Opened = "opened" | "already" | "none" | "unread" | "failed"

/** The field key a question of `screen`'s form has (form.ts `fieldOf`). */
const keyOf = (screen: string, question: Question) =>
  question.sessionID === screen ? `${KEY_PREFIX}${question.id}` : `${KEY_PREFIX}${question.sessionID}:${question.id}`

/** Whether a form of ours asks any question still open. */
const asksAny = (form: PendingForm, open: ReadonlySet<string>) => form.fields.some((field) => open.has(field.key))

/**
 * The open action of every session: `open(screen)` opens one form in the
 * session on screen for the questions open there now. A call while another
 * open of the session is under way answers `already` and does nothing.
 */
export const opener = (host: FormHost) => {
  const underWay = new Set<string>()

  /** The form of `questions`, held until the TUI lists it, so an open in between finds it and makes no second. */
  const made = (screen: string, questions: ReadonlyArray<Question>): Effect.Effect<Opened> =>
    Option.match(Option.fromUndefinedOr(formOf(questions, screen, host.asker)), {
      onNone: () => Effect.succeed<Opened>("none"),
      onSome: (input) =>
        host.create(screen, input).pipe(
          Effect.andThen(host.refresh(screen)),
          Effect.as<Opened>("opened"),
          Effect.catchTag("FormRefused", () => Effect.succeed<Opened>("failed")),
        ),
    })

  const run = (screen: string): Effect.Effect<Opened> =>
    Effect.gen(function* () {
      const showing = host.pending(screen).some(isOurs)
      const read = yield* Effect.option(host.read(screen))
      if (Option.isNone(read)) {
        // Unread: the form showing stays as it is; with none, nothing opens.
        if (showing) return "already"
        return "unread"
      }
      // A form of ours whose questions all closed meanwhile (answered, withdrawn) is never shown: it goes.
      const open = new Set(read.value.map((question) => keyOf(screen, question)))
      const ours = host.pending(screen).filter(isOurs)
      const stale = ours.filter((form) => !asksAny(form, open))
      yield* Effect.forEach(stale, (form) => host.cancel(screen, form.id), { discard: true })
      // Ours is there (another TUI's, or one listed while we read): this open only finds it.
      if (stale.length < ours.length) return "already"
      return yield* made(screen, read.value)
    })

  return {
    open: (screen: string): Effect.Effect<Opened> =>
      Effect.suspend(() => {
        if (underWay.has(screen)) return Effect.succeed<Opened>("already")
        underWay.add(screen)
        return run(screen).pipe(Effect.ensuring(Effect.sync(() => underWay.delete(screen))))
      }),
  }
}

/** The host's forms through the TUI plugin context. */
export const fromContext = (ctx: Plugin.Context): FormHost => {
  const listed = (sessionID: string) => Option.getOrElse(Option.fromNullishOr(ctx.data.session.form.list(sessionID)), Arr.empty)
  return {
    pending: listed,
    read: (sessionID) => {
      const parentOf = (id: string) => Option.getOrUndefined(Option.flatMapNullishOr(Option.fromNullishOr(ctx.data.session.get(id)), (session) => session.parentID))
      const members = ctx.data.session.family(sessionID).map((id) => ({ id, parentID: parentOf(id) }))
      return Effect.tryPromise({
        try: () => ctx.client.rpc(QUESTIONS).open({ sessionIDs: [...under(sessionID, members)] }, { location: ctx.location }),
        catch: () => new QuestionsUnread({ sessionID }),
      }).pipe(
        Effect.flatMap((answer) => Effect.fromOption(decodeOpen(answer))),
        Effect.map((open) => open.questions),
        Effect.mapError(() => new QuestionsUnread({ sessionID })),
      )
    },
    create: (sessionID, input) =>
      Effect.tryPromise({
        try: () => ctx.client.session.form.create({ sessionID, title: input.title, metadata: { ...input.metadata }, actions: input.actions, fields: input.fields }),
        catch: () => new FormRefused({ sessionID }),
      }).pipe(Effect.asVoid),
    // A refresh or cancel that fails leaves the list as the TUI's next read finds it.
    refresh: (sessionID) =>
      Effect.tryPromise(() => {
        ctx.data.session.form.invalidate(sessionID)
        return ctx.data.session.form.sync(sessionID)
      }).pipe(Effect.ignore),
    cancel: (sessionID, formID) =>
      Option.match(Arr.findFirst(listed(sessionID), (form) => form.id === formID), {
        onNone: () => Effect.void,
        onSome: (form) => Effect.tryPromise(() => ctx.data.session.form.cancel({ sessionID, formID: form.id })).pipe(Effect.ignore),
      }),
    asker: (sessionID) => {
      const session = ctx.data.session.get(sessionID)
      return askerOf({ id: sessionID, title: session?.title, agent: session?.agent })
    },
  }
}
