// The `model_next` tool as an agent sees it: queue, cancel or show a model
// switch for its own session (or another it names), through the same rules as
// `/model-next` and the picker's action. It answers in plain words.
import { Match, Option, Schema } from "effect"
import { toolInput } from "@dotfiles/decider/tool-input"
import { type Answer, label, type Shown, refusalText } from "./pending.ts"

export const NAME = "model_next"

export const ToolInput = toolInput(
  Schema.Struct({
    action: Schema.Literals(["queue", "cancel", "status"]).annotate({ description: "queue a switch, cancel the queued one, or show what is queued" }),
    model: Schema.optional(Schema.String).annotate({ description: "For queue: the model as provider/model, or provider/model#variant (e.g. anthropic/claude-fable-5-2)" }),
    session: Schema.optional(Schema.String).annotate({ description: "The session to act on; default: this session" }),
  }),
)
export type ToolInput = typeof ToolInput.Type

export const DESCRIPTION = [
  "Switch a session's model later instead of now, so the switch costs no full-price cache write.",
  "queue: the model takes over right after the session's next completed compaction (the current model still writes the summary), or at its next turn once its prompt cache has expired. Inside the cache's lifetime it never applies. Any direct model switch drops it; it survives a restart.",
  "cancel drops the queued switch; status shows it. A refusal says why (the session's own model, a model the catalog lacks, no such session).",
  "Which model a session runs on is the owner's call: queue one only when the owner or your orchestrator asked for it.",
].join("\n\n")

/** What the tool answers for a queue or cancel. */
export const answerLine = (answer: Answer): string =>
  Match.valueTags(answer, {
    Queued: (queued) => `${label(queued.from)} → ${label(queued.model)} queued: it applies after the next compaction, or at the next turn once the cache has expired.`,
    Cancelled: (cancelled) => Match.value(cancelled.had).pipe(Match.when(true, () => "The queued switch is cancelled."), Match.orElse(() => "No switch was queued.")),
    Refused: (refused) => `Not queued: ${refusalText(refused.reason)}.`,
  })

/** What the tool answers for a status. */
export const shownLine = (shown: Shown): string =>
  Option.match(Option.fromUndefinedOr(shown.pending), {
    onNone: () => `No switch queued${Option.match(Option.fromUndefinedOr(shown.current), { onNone: () => "", onSome: (current) => `; the session runs on ${label(current)}` })}.`,
    onSome: (pending) => `${Option.match(Option.fromUndefinedOr(shown.current), { onNone: () => "?", onSome: label })} → ${label(pending.model)} queued.`,
  })
