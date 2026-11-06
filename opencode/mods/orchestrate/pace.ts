// Pace: whether an account has room for one more agent now. The pool's
// `pace` answer and the Codex admission script's both read as one; a new
// subagent the pace holds latches, and is refused with PaceHeld only when
// the latch cannot be kept.
import { Schema } from "effect"

/** One answer about one new agent: admitted, or held with why and when it may open. */
export const Pace = Schema.Struct({
  ok: Schema.Boolean,
  measured: Schema.Boolean,
  reason: Schema.String,
  retryAt: Schema.optional(Schema.Number),
})
export interface Pace extends Schema.Schema.Type<typeof Pace> {}

/** A pace's reply to one ask: its answer, or why it gave none (no pool, a timeout, a failure, an undecodable answer). */
export const Answered = Schema.TaggedStruct("Answered", { pace: Pace })
export const FailedOpen = Schema.TaggedStruct("FailedOpen", { why: Schema.String })
export const PaceReply = Schema.Union([Answered, FailedOpen])
export type PaceReply = typeof PaceReply.Type

/** The pace a reply gives; one that failed open gives none, and the agent starts. */
export const paceOfReply = (reply: PaceReply): Pace | undefined => (reply._tag === "Answered" ? reply.pace : undefined)

/** Whose pace answered: the account pool's, or the Codex account's. */
export const Whose = Schema.Literals(["pool", "codex"])
export type Whose = typeof Whose.Type

/** A pace that holds a new agent: whose it is, why, and when it may open. */
export const PaceHold = Schema.Struct({
  whose: Whose,
  reason: Schema.String,
  retryAt: Schema.optional(Schema.Number),
})
export interface PaceHold extends Schema.Schema.Type<typeof PaceHold> {}

/** The pace holds a new subagent and no latch could be kept: whose pace, why, and when it opens (epoch ms). */
export class PaceHeld extends Schema.TaggedError<PaceHeld>()("PaceHeld", {
  whose: Whose,
  reason: Schema.String,
  retryAt: Schema.Number,
}) {}

/** A model as `provider/id`, with an optional `#variant`. */
export interface ModelRef {
  readonly providerID: string
  readonly id: string
  /** The variant the host runs it at, when it names one (a session's or an agent's model). */
  readonly variant?: string
}

/** A model as the subagent tool takes it: `provider/id`, with `#variant` when it names one. */
export const formatRef = (model: ModelRef) => `${model.providerID}/${model.id}${model.variant === undefined ? "" : `#${model.variant}`}`

/** The provider and model a `provider/id#variant` string names; undefined without a provider. */
export const parseModel = (model: unknown): ModelRef | undefined => {
  if (typeof model !== "string" || !model.includes("/")) return undefined
  const slash = model.indexOf("/")
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1).split("#")[0]! }
}

/**
 * Whether `model` names `ref` at any variant or none: `provider/id[#variant]`,
 * or the bare `id[#variant]` an orchestrator writes without its provider.
 */
export const namesModel = (model: string, ref: ModelRef): boolean => {
  const parsed = parseModel(model)
  return parsed === undefined ? model.split("#")[0] === ref.id : parsed.providerID === ref.providerID && parsed.id === ref.id
}

/** A model at a variant, as the subagent tool takes it. */
export const formatModel = (model: ModelRef, variant: string) => `${model.providerID}/${model.id}#${variant}`

/**
 * The orchestrate skill's Codex admission, read from the script's exit code
 * and last line: `admit: …` with 0, `hold: …[; opens about <date> <hh:mm>Z]`
 * with 1. Anything else is no answer, and fails open, saying the exit code.
 */
export const parseAdmission = (code: number | null, out: string): PaceReply => {
  const line = out.trim().split("\n").pop() ?? ""
  if (code === 0 && line.startsWith("admit: ")) return Answered.make({ pace: { ok: true, measured: true, reason: line.slice(7) } })
  if (code !== 1 || !line.startsWith("hold: ")) return FailedOpen.make({ why: `no admission line (exit ${code ?? "by signal"})` })
  const opens = /; opens about (\d{4}-\d\d-\d\d) (\d\d:\d\d)Z$/.exec(line)
  const retryAt = opens ? Date.parse(`${opens[1]}T${opens[2]}:00Z`) : undefined
  return Answered.make({
    pace: {
      ok: false,
      measured: true,
      reason: opens ? line.slice(6, opens.index) : line.slice(6),
      ...(retryAt === undefined ? {} : { retryAt }),
    },
  })
}
