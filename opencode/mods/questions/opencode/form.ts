// /answer through the host's question form: one form per asking session, for
// the open questions the tray of the session on screen shows (its own and its
// subagents'). The host's session view shows a pending form in the composer's
// place, its own and its subagents' one after another, exactly as it shows
// the built-in `question` tool's. A session that already has one of our
// forms pending gets no second.
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

/** Open a form for each asking session among `questions`, the session on screen first, then in the order they asked. */
export const openForms = async (host: FormHost, screen: string, questions: ReadonlyArray<Question>): Promise<Opened> => {
  const bySession = new Map<string, Array<Question>>()
  for (const question of questions.toSorted((left, right) => Number(right.sessionID === screen) - Number(left.sessionID === screen) || left.askedAt - right.askedAt))
    bySession.set(question.sessionID, [...(bySession.get(question.sessionID) ?? []), question])
  let opened = 0
  let already = 0
  const failed: Array<string> = []
  for (const [sessionID, asked] of bySession) {
    if (host.pending(sessionID).some(isOurs)) {
      already += 1
      continue
    }
    const input = formOf(asked, sessionID === screen ? undefined : host.asker(sessionID))
    if (input === undefined) continue
    const made = await host.create(sessionID, input).then(
      () => true,
      () => false,
    )
    if (made) opened += 1
    else failed.push(sessionID)
  }
  return { opened, already, failed }
}

/** The host's forms through the TUI plugin context. */
export const fromContext = (ctx: Plugin.Context): FormHost => ({
  pending: (sessionID) => ctx.data.session.form.list(sessionID) ?? [],
  create: (sessionID, input) =>
    ctx.client.session.form.create({ sessionID, title: input.title, metadata: { ...input.metadata }, actions: input.actions, fields: input.fields }),
  asker: (sessionID) => {
    const session = ctx.data.session.get(sessionID)
    return session?.agent ?? session?.title ?? sessionID
  },
})
