import { Schema } from "effect"

/** Model-facing shell decisions. A reshape carries an accepted form, not advice beside a refusal. */
export class CommandForm extends Schema.TaggedError<CommandForm>()("CommandForm", {
  form: Schema.String,
  reason: Schema.String,
}) {}

export const renderForm = ({ form, reason }: CommandForm): string =>
  `Not a refusal: a command-shape rule. Run it this way and continue:\n${form}\n${reason}`

/** This command was not checked to completion; it has no verified replacement. */
export class CannotTell extends Schema.TaggedError<CannotTell>()("CannotTell", {
  reason: Schema.String,
  instruction: Schema.String,
}) {}

export const renderUnknown = ({ reason, instruction }: CannotTell): string =>
  `Cannot tell: ${reason}\n${instruction}`

export const renderRefusal = (rule: string, reason: string): string => `Refused by ${rule}: ${reason}.`
