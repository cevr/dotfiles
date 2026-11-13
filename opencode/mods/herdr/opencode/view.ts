// The view the decision reads, from the TUI's own data: the current route's
// root session and every session in its family, each with the host's run
// status, its queued input, its waiting permissions and questions, its open
// background questions (from questions.ts, which follows the questions
// plugin), and the tool calls running in its newest assistant message. Read
// inside a Solid computation, every read here is reactive.
import { Option, Schema } from "effect"
import type { Asked, SessionView, View } from "../activity.ts"
import type { RunningTool } from "../label.ts"

/**
 * The reads the view needs from the TUI plugin's `context.data`, narrowed to
 * what it uses so a test can supply them; `context.data` satisfies it.
 */
export interface Reads {
  readonly session: {
    get(sessionID: string): { readonly title?: string } | undefined
    root(sessionID: string): string
    family(sessionID: string): ReadonlyArray<string>
    status(sessionID: string): "idle" | "running"
    readonly pending: { list(sessionID: string): ReadonlyArray<{ readonly type: string }> }
    readonly permission: { list(sessionID: string): ReadonlyArray<{ readonly action: string; readonly resources: ReadonlyArray<string> }> | undefined }
    readonly form: { list(sessionID: string): ReadonlyArray<{ readonly title: string }> | undefined }
    readonly message: { list(sessionID: string): ReadonlyArray<{ readonly type: string; readonly content?: unknown }> }
  }
}

/** The open background questions a session asked, as questions.ts follows them. */
export type AskedOf = (sessionID: string) => ReadonlyArray<Asked>

/** The route the TUI shows, as `context.ui.router.current()` returns it. */
export type Route = { readonly type: "session"; readonly sessionID: string } | { readonly type: string }

/** A tool call the host is running: past streaming its input, not yet settled. */
const RunningPart = Schema.Struct({
  type: Schema.Literal("tool"),
  name: Schema.String,
  state: Schema.Struct({ status: Schema.Literal("running"), input: Schema.Record(Schema.String, Schema.Unknown) }),
  time: Schema.Struct({ created: Schema.Number, ran: Schema.optional(Schema.Number) }),
})
const decodeRunning = Schema.decodeUnknownOption(RunningPart)

const runningTools = (reads: Reads, sessionID: string): ReadonlyArray<RunningTool> => {
  const newest = reads.session.message.list(sessionID).findLast((message) => message.type === "assistant")
  const content: ReadonlyArray<unknown> = Array.isArray(newest?.content) ? newest.content : []
  return content.flatMap((part) => {
    const running = decodeRunning(part)
    if (Option.isNone(running)) return []
    return [{ tool: running.value.name, input: running.value.state.input, at: running.value.time.ran ?? running.value.time.created }]
  })
}

/** One session of the view, by id. */
export const session = (reads: Reads, asked: AskedOf, id: string): SessionView => {
  const title = reads.session.get(id)?.title
  return {
    id,
    ...(title === undefined ? {} : { title }),
    running: reads.session.status(id) === "running",
    // Parked synthetic context (user shells, plan reminders) stays pending without work; the host's own tabs count it the same way.
    queued: reads.session.pending.list(id).some((item) => item.type !== "synthetic"),
    permissions: (reads.session.permission.list(id) ?? []).map((request) =>
      request.resources[0] === undefined ? request.action : `${request.action} ${request.resources[0]}`,
    ),
    questions: (reads.session.form.list(id) ?? []).map((form) => form.title),
    asked: asked(id),
    tools: runningTools(reads, id),
  }
}

/** The sessions of `route`'s view: its root first, then the root's family; none off a session route. */
export const membersOf = (reads: Reads, route: Route): ReadonlyArray<string> => {
  if (!("sessionID" in route) || route.type !== "session" || route.sessionID === "dummy") return []
  const root = reads.session.root(route.sessionID)
  return [root, ...reads.session.family(root).filter((id) => id !== root)]
}

const none: AskedOf = () => []

/** The view off a session route: no session. */
export const noView: View = { root: undefined, descendants: [] }

/** The view of `route`: its root session and that root's family, or no session off a session route. */
export const read = (reads: Reads, route: Route, asked: AskedOf = none): View => {
  const [root, ...descendants] = membersOf(reads, route)
  if (root === undefined) return noView
  return { root: session(reads, asked, root), descendants: descendants.map((id) => session(reads, asked, id)) }
}
