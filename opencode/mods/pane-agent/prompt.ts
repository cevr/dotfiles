import { Option } from "effect"

export interface BriefInput {
  readonly prompt: string
  readonly resultFile: string
  readonly followUp?: boolean
}

export interface ResumeBriefInput {
  readonly prompt?: string
  readonly resultFile: string
}

const headingFor = (followUp?: boolean): string => {
  if (followUp === true) return "[Follow-up from the orchestrator]"
  return "[Task from the orchestrator]"
}

/**
 * Formats the plain task brief typed into a harness pane.
 * Names the sender only as "the orchestrator" and specifies an atomic write-then-rename result hand-back.
 */
export const taskBrief = (input: BriefInput): string => {
  const heading = headingFor(input.followUp)
  return [
    heading,
    "",
    input.prompt.trim(),
    "",
    `When finished, write your final answer to ${input.resultFile}.tmp, then rename it to ${input.resultFile}.`,
  ].join("\n")
}

/** Formats the initial prompt passed to a restarted harness pane (`--continue -i`). */
export const resumeBrief = (input: ResumeBriefInput): string => {
  const body = Option.getOrElse(
    Option.filter(Option.map(Option.fromUndefinedOr(input.prompt), (text) => text.trim()), (text) => text.length > 0),
    () => "Your previous pane closed. Continue the task from where you left off.",
  )
  return taskBrief({ prompt: body, resultFile: input.resultFile, followUp: true })
}
