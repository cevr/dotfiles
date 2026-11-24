export interface BriefInput {
  readonly prompt: string
  readonly resultFile: string
  readonly followUp?: boolean
}

/**
 * Formats the plain task brief typed into a harness pane.
 * Names the sender only as "the orchestrator" and requests the answer in resultFile.
 */
const headingFor = (followUp?: boolean): string => {
  if (followUp === true) return "[Follow-up from the orchestrator]"
  return "[Task from the orchestrator]"
}

export const taskBrief = (input: BriefInput): string => {
  const heading = headingFor(input.followUp)
  return [
    heading,
    "",
    input.prompt.trim(),
    "",
    `When finished, write your final answer to ${input.resultFile}.`,
  ].join("\n")
}
