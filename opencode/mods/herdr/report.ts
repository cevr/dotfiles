// The reports herdr receives, as values: who reports (source and agent), the
// sequence that orders them, the resume command, and the params of each
// request, built from an activity. Which requests an activity change needs is
// decided here too; model.ts sends them.
import type { Activity, State } from "./activity.ts"
import { isControl } from "./label.ts"

/** Our lifecycle source: our own, never herdr's `herdr:` namespace. */
export const SOURCE = "dotfiles:opencode"
export const AGENT = "opencode"

/** How long herdr keeps our labels without a refresh. */
export const METADATA_TTL_MS = 600_000
/** How often an unchanged label is refreshed, well inside its ttl. */
export const METADATA_REFRESH_MS = METADATA_TTL_MS / 2

/** Where reports go: herdr's socket and our pane in it. */
export interface Pane {
  readonly paneId: string
  readonly socketPath: string
}

/**
 * The pane this process runs in, from the environment herdr gives a pane's
 * processes; none outside herdr, which leaves the reporter off.
 */
export const paneOf = (env: Readonly<Record<string, string | undefined>>): Pane | undefined => {
  const paneId = env.HERDR_PANE_ID ?? ""
  const socketPath = env.HERDR_SOCKET_PATH ?? ""
  if (env.HERDR_ENV !== "1" || paneId === "" || socketPath === "") return undefined
  return { paneId, socketPath }
}

/**
 * The next sequence number: past every earlier one, and tracking the clock in
 * microseconds, so a reporter that replaces this one (a restarted TUI) still
 * counts upward. herdr ignores a report whose number is not higher than the
 * last it accepted from our source.
 */
export const nextSeq = (previous: number, nowMillis: number) => Math.max(previous + 1, Math.floor(nowMillis) * 1000)

// herdr's rules for a resume command (herdr-add-support: "Report the resume command").
const MAX_ARGS = 64
const MAX_BYTES = 8 * 1024
const forbidden = (arg: string) => Array.from(arg).some((char) => char === "'" || isControl(char))

/** Whether herdr accepts `argv` as a resume command: a plain command name first, no apostrophe or control character, at most 64 elements and 8 KiB. */
export const validResumeArgv = (argv: ReadonlyArray<string>) => {
  const head = argv[0]
  if (head === undefined || head === "" || head.includes("/") || head.includes("\\")) return false
  if (argv.length > MAX_ARGS) return false
  if (argv.some(forbidden)) return false
  return argv.reduce((bytes, arg) => bytes + new TextEncoder().encode(arg).length, 0) <= MAX_BYTES
}

/** The command that reopens `sessionId`: `opencode -s <id>`, or none when herdr would refuse it. */
export const resumeArgv = (sessionId: string): ReadonlyArray<string> | undefined => {
  const argv = [AGENT, "-s", sessionId]
  return validResumeArgv(argv) ? argv : undefined
}

// ── The requests' params, as herdr's socket API names them ──

export interface AgentParams {
  readonly pane_id: string
  readonly source: string
  readonly agent: string
  readonly state: State
  readonly seq: number
  readonly message?: string
  readonly agent_session_id?: string
  readonly resume_argv?: ReadonlyArray<string>
}

export interface MetadataParams {
  readonly pane_id: string
  readonly source: string
  /** Guards: the labels apply only while our agent and source hold the pane. */
  readonly agent: string
  readonly applies_to_source: string
  readonly seq: number
  readonly ttl_ms: number
  readonly title?: string
  readonly state_labels?: { readonly working: string }
  readonly clear_title?: true
  readonly clear_state_labels?: true
}

export interface ReleaseParams {
  readonly pane_id: string
  readonly source: string
  readonly agent: string
  readonly seq: number
}

/** `pane.report_agent`: the state, why it blocks, the session, and the command that resumes it. */
export const agentParams = (paneId: string, activity: Activity, seq: number): AgentParams => {
  const resume = activity.sessionId === undefined ? undefined : resumeArgv(activity.sessionId)
  return {
    pane_id: paneId,
    source: SOURCE,
    agent: AGENT,
    state: activity.state,
    seq,
    ...(activity.message === undefined ? {} : { message: activity.message }),
    ...(activity.sessionId === undefined ? {} : { agent_session_id: activity.sessionId }),
    ...(resume === undefined ? {} : { resume_argv: resume }),
  }
}

/**
 * `pane.report_metadata`: the root session's title and, while working, what
 * runs now. A label the activity no longer has is cleared, not left behind.
 */
export const metadataParams = (paneId: string, activity: Activity, seq: number): MetadataParams => ({
  pane_id: paneId,
  source: SOURCE,
  agent: AGENT,
  applies_to_source: SOURCE,
  seq,
  ttl_ms: METADATA_TTL_MS,
  ...(activity.title === undefined ? { clear_title: true } : { title: activity.title }),
  ...(activity.state === "working" && activity.working !== undefined ? { state_labels: { working: activity.working } } : { clear_state_labels: true }),
})

/** `pane.release_agent`: the pane is ours no more. */
export const releaseParams = (paneId: string, seq: number): ReleaseParams => ({ pane_id: paneId, source: SOURCE, agent: AGENT, seq })

/** What herdr needs to hear when the activity moves from `previous` (none yet) to `next`. */
export const changes = (previous: Activity | undefined, next: Activity) => {
  const label = (activity: Activity) => ({ title: activity.title, working: activity.state === "working" ? activity.working : undefined })
  return {
    agent:
      previous === undefined ||
      previous.state !== next.state ||
      previous.message !== next.message ||
      previous.sessionId !== next.sessionId,
    metadata:
      previous === undefined ||
      label(previous).title !== label(next).title ||
      label(previous).working !== label(next).working,
  }
}
