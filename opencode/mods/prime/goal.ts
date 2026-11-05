// The session goal as Prime shows it: one line above the composer while a goal
// exists, in the goal's state colour. The dock shows no goal.
//   active    ● goal · ship the dock · 3↻ · /goal pause · /goal cancel
//   paused    ‖ goal paused · stopped by user · /goal resume · /goal cancel
//   complete  ✓ goal met · ship the dock          (muted, gone after a moment)
// With no goal neither shows. As the width shrinks the objective truncates
// first, down to a few cells, then the hints drop, then the round count.

/** A session's goal, as `/goal` set it (the host's SessionGoal, narrowed). */
export type Goal = {
  readonly objective: string
  readonly status: "active" | "paused" | "complete"
  /** Why the goal last changed. */
  readonly reason?: string
  /** Continuations sent since the goal was set or last resumed. */
  readonly rounds: number
  /** When the goal last changed, epoch ms. */
  readonly updatedAt: number
}

export type GoalTone = "success" | "warning" | "muted"

/** How long a met goal stays on screen. */
export const GOAL_LINGER_MS = 10_000

/** Whether the goal shows at `now`: active or paused always, met only for a moment after. */
export const goalShown = (goal: Goal | undefined, now: number): goal is Goal =>
  goal !== undefined && (goal.status !== "complete" || now - goal.updatedAt < GOAL_LINGER_MS)

export const goalTone = (goal: Goal): GoalTone =>
  goal.status === "active" ? "success" : goal.status === "paused" ? "warning" : "muted"

/**
 * The goal line in at most `width` cells: `lead` in the state colour, `body`
 * (the objective, or the pause's reason) in the text colour, `rest` (the
 * round count and the commands) faint.
 */
export type GoalLine = { readonly tone: GoalTone; readonly lead: string; readonly body: string; readonly rest: string }

const SEP = " · "
/** The objective keeps at least this many cells before the hints drop. */
const BODY_MIN = 16

const cells = (text: string) => [...text].length
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()
const clip = (text: string, max: number): string => {
  if (cells(text) <= max) return text
  if (max <= 1) return max === 1 ? "…" : ""
  return `${[...text].slice(0, max - 1).join("").trimEnd()}…`
}

export const goalLine = (goal: Goal, width: number): GoalLine => {
  const tone = goalTone(goal)
  const lead = goal.status === "active" ? "● goal" : goal.status === "paused" ? "‖ goal paused" : "✓ goal met"
  const said = oneLine(goal.status === "paused" ? (goal.reason ?? "") : goal.objective)
  const count = goal.status === "active" && goal.rounds > 0 ? [`${goal.rounds}↻`] : []
  const hints =
    goal.status === "active" ? ["/goal pause", "/goal cancel"] : goal.status === "paused" ? ["/goal resume", "/goal cancel"] : []
  // Each try keeps fewer of the tail parts; the first whose objective keeps its minimum wins.
  const tails = [[...count, ...hints], count, []]
  const fit = (tail: ReadonlyArray<string>, min: number) => {
    const rest = tail.map((part) => `${SEP}${part}`).join("")
    if (said === "") return cells(lead) + cells(rest) <= width ? { tone, lead, body: "", rest } : undefined
    const room = width - cells(lead) - cells(SEP) - cells(rest)
    if (room < Math.min(min, cells(said))) return undefined
    return { tone, lead, body: `${SEP}${clip(said, room)}`, rest }
  }
  for (const tail of tails) {
    const line = fit(tail, BODY_MIN)
    if (line) return line
  }
  return fit([], 1) ?? { tone, lead, body: "", rest: "" }
}
