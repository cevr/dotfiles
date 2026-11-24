import { Schema } from "effect"

/** Model-facing shell decisions. A reshape carries an accepted form, not advice beside a refusal. */
export class CommandForm extends Schema.TaggedError<CommandForm>()("CommandForm", {
  form: Schema.String,
  reason: Schema.String,
}) {}

export const renderForm = ({ form, reason }: CommandForm): string =>
  `Not a refusal: a command-shape rule. Run it this way and continue:\n${form}\n${reason}`

export const renderRefusal = (rule: string, reason: string): string => `Refused by ${rule}: ${reason}.`
