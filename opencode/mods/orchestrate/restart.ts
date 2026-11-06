// A subagent a restart cut: which child sessions OpenCode's shutdown left in
// the middle of a turn that nothing will continue, and how they are resumed.
//
// OpenCode itself continues a cut root session and a cut background subagent
// at its next start (a `restart` notice, packages/core/src/session/execution/
// restart.ts). It leaves a foreground subagent: the parent's call to it ends
// `Tool execution interrupted (sessionID: <child>)`, the child's claim is
// released, and the child stays cut until its parent calls it again by hand.
// These rules find such children from their transcripts alone, so they hold
// whatever left the child cut, and never double OpenCode's own resume.
//
// How a turn ended, as the transcript records it (the fork's
// packages/schema/src/session-message.ts `Idle`): a turn's end is an `idle`
// marker, `succeeded`, `failed` or `interrupted`. A shutdown writes none: the
// running step's assistant message ends aborted (`Step interrupted`) and the
// turn stays open. A user's Escape, or a parent's cancel, writes `interrupted`.
// A shutdown can also reach a foreground child through its parent's call
// (the call's interrupt cancels the child), which writes `interrupted` in the
// child; then the parent's own turn tells them apart: the parent's turn that
// made the call was cut by the shutdown too (no `interrupted` marker of its
// own after it, or its own parent's cut reached it the same way).
//
// Plain functions over plain views; the model (model.ts) reads the views
// through the `Restarts` contract and acts on what these decide.

/** A subagent call in an assistant message: its tool part's id, the child it ran, and whether it ended interrupted. */
export interface SubagentCall {
  readonly id: string
  readonly child: string
  readonly interrupted: boolean
}

/** A message of a session's context, as the restart reads it. Times in epoch ms. */
export type Entry =
  /** A user prompt: the owner's, a parent's follow-up, or a resume. */
  | { readonly type: "prompt"; readonly at: number; readonly text: string }
  /** OpenCode's own `restart` notice: it continues the session itself. */
  | { readonly type: "restarted"; readonly at: number }
  | {
      readonly type: "assistant"
      readonly id: string
      readonly agent: string
      /** When it ended: its completion, else its start. */
      readonly at: number
      /** It ended aborted: a shutdown or an interrupt cut its step. */
      readonly aborted: boolean
      readonly calls: ReadonlyArray<SubagentCall>
    }
  | { readonly type: "idle"; readonly at: number; readonly outcome: "succeeded" | "failed" | "interrupted" }
  /** This plugin's notice to a parent, naming the children it was about. A notice on the side, like `other`. */
  | { readonly type: "told"; readonly at: number; readonly children: ReadonlyArray<string> }
  /** Anything else: a notice that did not start a turn, a switch, a compaction. */
  | { readonly type: "other" }

/** How a session's last turn ended. */
export type Ending =
  /** Its step was aborted and no turn end followed: a shutdown left it open. */
  | { readonly _tag: "Cut"; readonly at: number }
  /** Its step was aborted, then interrupted: a user's or a parent's cancel, or a shutdown through its parent's call. */
  | { readonly _tag: "Interrupted"; readonly at: number }
  /** It ended, runs, or was continued: nothing to resume. */
  | { readonly _tag: "Settled" }

const SETTLED: Ending = { _tag: "Settled" }

/** Whether an entry is part of a turn's course, not a notice on the side. */
const marks = (entry: Entry) => entry.type !== "other" && entry.type !== "told"

/** Whether the parent was already told about `child` since `at`: a child left to it is named once. */
export const toldSince = (parent: ReadonlyArray<Entry>, child: string, at: number) =>
  parent.some((entry) => entry.type === "told" && entry.at >= at && entry.children.includes(child))

/** How the last turn ended. A prompt or OpenCode's restart notice after the aborted step means it was continued. */
export const ending = (entries: ReadonlyArray<Entry>): Ending => {
  const last = entries.findLastIndex(marks)
  const tail = entries[last]
  if (tail?.type === "assistant") return tail.aborted ? { _tag: "Cut", at: tail.at } : SETTLED
  if (tail?.type !== "idle" || tail.outcome !== "interrupted") return SETTLED
  const before = entries.slice(0, last).findLast(marks)
  return before?.type === "assistant" && before.aborted ? { _tag: "Interrupted", at: before.at } : SETTLED
}

/** The prompt a cut child is resumed with. */
export const RESUME_PROMPT = "Your turn ended when OpenCode restarted; continue where you left off."

/** What the resume adds: the restart cut its shells too. */
const SHELLS = "Any shell you had running was cut by the restart; rerun the ones you still need."

/** The whole resume prompt. */
export const resumePrompt = `${RESUME_PROMPT} ${SHELLS}`

/** Waits before each resume of one turn, in order: the first lets OpenCode's own restart recovery land first. */
export const BACKOFF_MS: ReadonlyArray<number> = [10_000, 120_000, 600_000]

/** How far back a cut counts: a turn cut longer ago than this before the start is left to its parent. */
export const WINDOW_MS = 6 * 60 * 60 * 1000

/** How many resumes in a row the last turns were: the user prompts since the last one that was not a resume. */
export const resumes = (entries: ReadonlyArray<Entry>): number => {
  let count = 0
  for (const entry of entries.toReversed()) {
    if (entry.type !== "prompt") continue
    if (!entry.text.startsWith(RESUME_PROMPT)) break
    count += 1
  }
  return count
}

/** The parent's last call to `child`: the assistant message, the call, the agent that made it, and where it is. */
export const callTo = (entries: ReadonlyArray<Entry>, child: string) => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry?.type !== "assistant") continue
    const call = entry.calls.findLast((item) => item.child === child)
    if (call !== undefined) return { messageID: entry.id, callID: call.id, agent: entry.agent, interrupted: call.interrupted, index }
  }
  return undefined
}

/** Whether the turn that holds entry `index` was then interrupted: its next turn end, before any prompt, is `interrupted`. */
const interruptedAfter = (entries: ReadonlyArray<Entry>, index: number) => {
  const next = entries.slice(index + 1).find((entry) => entry.type === "prompt" || entry.type === "restarted" || entry.type === "idle")
  return next?.type === "idle" && next.outcome === "interrupted"
}

/**
 * Whether a parent's call to `child` was cut by the restart: the call ended
 * interrupted, and the parent's turn was not interrupted after it, or was
 * because the restart cut the parent itself (`parentCut`).
 */
export const callCut = (parent: ReadonlyArray<Entry>, child: string, parentCut: boolean): boolean => {
  const call = callTo(parent, child)
  if (call === undefined || !call.interrupted) return false
  return !interruptedAfter(parent, call.index) || parentCut
}

/**
 * Whether a turn that ended so was cut before this start (`boot`), within the
 * window: the restart's when cut with no turn end; when interrupted, only
 * if its parent's call was cut (`callCut`).
 */
export const inWindow = (end: Ending, boot: number): end is Exclude<Ending, { readonly _tag: "Settled" }> =>
  end._tag !== "Settled" && end.at < boot && boot - end.at <= WINDOW_MS

/** What becomes of a cut child: resumed after a wait, or left to its parent after too many resumes in a row. */
export type Verdict =
  | { readonly _tag: "Resume"; readonly attempt: number; readonly waitMs: number }
  | { readonly _tag: "GiveUp"; readonly attempts: number }

/** A child resumed `tries` times in a row waits `backoff[tries]`; past the last, it is left. */
export const verdict = (tries: number, backoff: ReadonlyArray<number> = BACKOFF_MS): Verdict => {
  const waitMs = backoff[tries]
  return waitMs === undefined ? { _tag: "GiveUp", attempts: tries } : { _tag: "Resume", attempt: tries + 1, waitMs }
}

/** A child as the parent's notice names it. */
export interface Named {
  readonly child: string
  readonly description: string
}

/** The notice's title, as the transcript draws it. */
export const NOTICE_TITLE = "Subagents resumed after a restart"

/** Why a cut child was left to its parent. */
export const gaveUp = (attempts: number) => `cut by ${attempts} restarts in a row`

/** The parent's notice: once per restart, naming each child resumed and each left to it, with why. */
export const notice = (resumed: ReadonlyArray<Named>, left: ReadonlyArray<Named & { readonly why: string }>): string => {
  const name = (item: Named) => `${item.description} (sessionID: ${item.child})`
  const lines = ["orchestrate: OpenCode restarted and cut the turn of your subagents below. Their shells were cut too."]
  if (resumed.length > 0)
    lines.push(
      `Resumed in the background: ${resumed.map(name).join("; ")}.`,
      "Each one's result wakes you, as for a background subagent. Do not call them to resume them.",
    )
  for (const item of left) lines.push(`Not resumed: ${name(item)}, ${item.why}. Continue it yourself if it still matters.`)
  return lines.join("\n")
}
