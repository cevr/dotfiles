// /answer through the host's question form: one form, in the session on
// screen, for the open questions its tray shows (its own and its subagents',
// at any depth), so the owner answers a subagent's question where they look,
// as they answer the session's own. The host's session view shows a pending
// form in the composer's place, exactly as it shows the built-in `question`
// tool's. A session that already has one of our forms pending gets no second.
//
// `openForms` works on a plain view of the TUI plugin context, so the seam
// test runs it over a stand-in; `fromContext` takes the view from the context.
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
import { askerOf } from "../asker.ts"
import { type FormInput, formOf, isOurs } from "../form.ts"
import type { Question } from "../question.ts"

/** The host as /answer reaches it. */
export interface FormHost {
  /** The session's pending forms. */
  readonly pending: (sessionID: string) => ReadonlyArray<{ readonly fields: ReadonlyArray<{ readonly key: string }> }>
  /** Open a form in the session. */
  readonly create: (sessionID: string, input: FormInput) => Promise<unknown>
  /** Who a session is, to name the asker. */
  readonly asker: (sessionID: string) => string
}

/** What /answer did: how many forms it opened, how many it found open already, and the sessions whose form failed. */
export interface Opened {
  readonly opened: number
  readonly already: number
  readonly failed: ReadonlyArray<string>
}

/** Open one form in the session on screen for `questions`, its own and its subagents' (formOf), unless one of ours is pending there. */
export const openForms = async (host: FormHost, screen: string, questions: ReadonlyArray<Question>): Promise<Opened> => {
  if (host.pending(screen).some(isOurs)) return { opened: 0, already: 1, failed: [] }
  const input = formOf(questions, screen, host.asker)
  if (input === undefined) return { opened: 0, already: 0, failed: [] }
  const made = await host.create(screen, input).then(
    () => true,
    () => false,
  )
  return made ? { opened: 1, already: 0, failed: [] } : { opened: 0, already: 0, failed: [screen] }
}

/** The host's forms through the TUI plugin context. */
export const fromContext = (ctx: Plugin.Context): FormHost => ({
  pending: (sessionID) => ctx.data.session.form.list(sessionID) ?? [],
  create: (sessionID, input) =>
    ctx.client.session.form.create({ sessionID, title: input.title, metadata: { ...input.metadata }, actions: input.actions, fields: input.fields }),
  asker: (sessionID) => {
    const session = ctx.data.session.get(sessionID)
    return askerOf({ id: sessionID, title: session?.title, agent: session?.agent })
  },
})
