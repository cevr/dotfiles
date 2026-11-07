// What OpenCode is doing, as herdr shows it: one value decided from the TUI's
// view of the session it shows. The decision is pure; opencode/view.ts reads
// the view from the TUI's data, and model.ts reports the activity.
import { clip, oneLine, workingLabel, type RunningTool } from "./label.ts"

/** herdr's semantic agent states (its `PaneAgentState`). */
export type State = "idle" | "working" | "blocked" | "unknown"

/** One session as the decision reads it. */
export interface SessionView {
  readonly id: string
  readonly title?: string
  /** The host's own status: an execution runs (`data.session.status` is "running"). */
  readonly running: boolean
  /** Input the session holds for work that has not started yet (non-synthetic pending items). */
  readonly queued: boolean
  /** What each permission request waiting for the user asks for (its action, and its first resource), oldest first. */
  readonly permissions: ReadonlyArray<string>
  /** The titles of the forms (questions) waiting for the user, oldest first. */
  readonly questions: ReadonlyArray<string>
  /** The background questions (`ask_user_async`) open for the user to answer from the tray. */
  readonly asked: ReadonlyArray<Asked>
  /** The tool calls running now. */
  readonly tools: ReadonlyArray<RunningTool>
}

/** An open background question: its label, and when it was asked (epoch ms). */
export interface Asked {
  readonly label: string
  readonly at: number
}

/**
 * What the TUI shows: the root session of the current route and every
 * session it started, at any depth (the host's family). `undefined` when no
 * session is open (the home screen, a plugin page).
 */
export interface View {
  readonly root: SessionView | undefined
  readonly descendants: ReadonlyArray<SessionView>
}

/** What herdr is told: the state, why it blocks, the session, and the labels. */
export interface Activity {
  readonly state: State
  /** Why it blocks; only for `blocked`. */
  readonly message?: string
  readonly sessionId?: string
  /** The root session's title. */
  readonly title?: string
  /** What runs now; only for `working`. */
  readonly working?: string
}


/**
 * The activity of a view:
 * - `unknown` when no session is open;
 * - `blocked` when the root or any session it started waits on a permission
 *   (first) or a question form, with a short message naming it;
 * - `working` while any of them runs or holds queued input, which is what
 *   makes kernel-driven and background-worker work count; an open background
 *   question never stops the agent, so it does not block work;
 * - `blocked` when none of them works and background questions are open:
 *   the agent waits on the answers, so the message names the oldest;
 * - `idle` otherwise.
 */
export const decide = (view: View): Activity => {
  const root = view.root
  if (root === undefined) return { state: "unknown" }
  const members = [root, ...view.descendants]
  const title = root.title === undefined ? undefined : oneLine(root.title) || undefined
  const base = { sessionId: root.id, ...(title === undefined ? {} : { title }) }
  const permission = members.flatMap((session) => session.permissions)[0]
  if (permission !== undefined) return { ...base, state: "blocked", message: blockedMessage("Permission", permission) }
  const question = members.flatMap((session) => session.questions)[0]
  if (question !== undefined) return { ...base, state: "blocked", message: blockedMessage("Question", question) }
  if (!members.some((session) => session.running || session.queued)) {
    const asked = members.flatMap((session) => session.asked).toSorted((a, b) => a.at - b.at)
    const oldest = asked[0]
    if (oldest === undefined) return { ...base, state: "idle" }
    const message =
      asked.length === 1
        ? blockedMessage("Question", oldest.label)
        : blockedMessage(`${asked.length} questions`, oldest.label, `${asked.length} questions need input`)
    return { ...base, state: "blocked", message }
  }
  const working = workingLabel(
    members.flatMap((session) => session.tools),
    view.descendants.filter((session) => session.running).length,
  )
  return { ...base, state: "working", ...(working === undefined ? {} : { working }) }
}

const blockedMessage = (kind: string, subject: string, empty = `${kind} needs input`) => {
  const text = oneLine(subject)
  return text ? clip(`${kind}: ${text}`) : empty
}

/** Two activities herdr would show the same way. */
export const sameActivity = (a: Activity, b: Activity) =>
  a.state === b.state && a.message === b.message && a.sessionId === b.sessionId && a.title === b.title && a.working === b.working
