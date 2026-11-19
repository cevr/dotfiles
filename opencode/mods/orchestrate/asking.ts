// A subagent asks its orchestrator, not the owner (owner, 2026-11-19: "the
// orchestrator has more higher level knowledge … the questions it asks are too
// contextual for me to answer"). The two tools as the agents see them, their
// inputs and descriptions, what each answers and refuses, which tool a session
// may use, and the nudge both sides read: check the documents first.
//
// - `ask_orchestrator`: a session with a parent asks as `ask_user_async`
//   does; its questions are put to its parent, which reads one letter per ask.
//   A root is refused: it asks the owner.
// - `answer_subagent`: the session a question is put to answers it by its ref;
//   the answer reaches the subagent as the owner's would. A parent that cannot
//   answer asks upward itself, in its own words: a root with
//   `ask_user_async`, a subagent with `ask_orchestrator`. Nothing forwards.
//
// The store, the letters and the answer path are the questions plugin's
// (`put`, `reply`); this module only words and routes.
import { Array as Arr, Option, Schema } from "effect"
import { toolInput } from "@dotfiles/decider/tool-input"

export const ASK_ORCHESTRATOR = "ask_orchestrator"
export const ANSWER_SUBAGENT = "answer_subagent"
/** The questions plugin's tool a root asks the owner with. */
export const ASK_OWNER = "ask_user_async"

/** Who a subagent's question goes to: its orchestrator (the default), or the owner as before. */
export const Subagents = Schema.Literals(["orchestrator", "owner"])
export type Subagents = typeof Subagents.Type

const MAX_ASKED = 3
const MAX_HEADER = 30
const MAX_OPTIONS = 4
const MAX_OPEN = 8

const Choice = Schema.Struct({
  label: Schema.String.annotate({ description: "The choice, as your orchestrator picks it (1-5 words)" }),
  description: Schema.optional(Schema.String).annotate({ description: "What the choice means, if the label does not say" }),
})

const AskedQuestion = Schema.Struct({
  question: Schema.String.annotate({
    description: "The question, self-contained, saying what you already checked (which documents) and why they do not settle it",
  }),
  header: Schema.optional(Schema.String).annotate({ description: `A short label for the question (at most ${MAX_HEADER} characters)` }),
  options: Schema.optional(Schema.Array(Choice)).annotate({ description: `At most ${MAX_OPTIONS} choices; your orchestrator may also write its own answer` }),
  assume: Schema.String.annotate({
    description: "What you do until an answer arrives. You continue on it now. When it is one of your options, start with that option's label",
  }),
})

export const AskOrchestratorInput = toolInput(
  Schema.Struct({
    questions: Schema.optional(Schema.Array(AskedQuestion)).annotate({ description: `1-${MAX_ASKED} questions to ask your orchestrator in the background` }),
    withdraw: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Ids of your open questions that no longer matter (q1, q2, …)" }),
  }),
)
export type AskOrchestratorInput = typeof AskOrchestratorInput.Type

export const AnswerSubagentInput = toolInput(
  Schema.Struct({
    answers: Schema.Array(
      Schema.Struct({
        id: Schema.String.annotate({ description: "The question's ref as its letter gives it: <asking session id>:<question id>" }),
        text: Schema.String.annotate({ description: "Your answer, in the subagent's terms; cite the document it rests on" }),
      }),
    ).annotate({ description: "One answer per question; a subagent's several go to it as one message" }),
  }),
)
export type AnswerSubagentInput = typeof AnswerSubagentInput.Type

/** The run's ledger, named in words: finding a run's plan.md is the run's own business. */
const LEDGER = "the run's ledger (plan.md, the queue)"

/** `a, b, and the run's ledger (…)`: the documents and the ledger, as one list. */
const listed = (paths: ReadonlyArray<string>, ledger: string): string =>
  Arr.match(paths, { onEmpty: () => ledger, onNonEmpty: (some) => `${some.join(", ")}, and ${ledger}` })

export const ASK_ORCHESTRATOR_DESCRIPTION = [
  "Ask your orchestrator (the session that started you) questions in the background and continue at once on a stated assumption. Returns immediately; your turn does not wait, and an unanswered question never blocks you.",
  "Your orchestrator has the wider context: the plan, the other units and the owner's earlier answers. First check the documents yourself (NORTH_STAR.md, AGENTS.md, the principles folder and the run's ledger, plan.md and the queue) and ask only what they do not settle; say in the question what you checked.",
  "Its answer arrives later as a message in this session (it wakes you if you are idle), naming the question, your assumption and the answer, and saying whether they differ; when they differ, revise the work that rests on the assumption. While a question is open, state its assumption in your final answer. Asking the same question again replaces the open one; withdraw one that no longer matters with withdraw: [id]. " +
    `At most ${MAX_OPEN} stay open; past that the oldest drops.`,
].join("\n\n")

export const ANSWER_SUBAGENT_DESCRIPTION = [
  "Answer a question one of your subagents put to you (ask_orchestrator), by the ref its letter gives (<session id>:<question id>). The answer reaches the subagent as the owner's would, naming its assumption and whether yours differs.",
  "Answer from the documents (NORTH_STAR.md, AGENTS.md, the principles, the run's ledger) and your wider context, and cite what you used. What only the owner can decide, ask the owner yourself (ask_user_async, or ask_orchestrator when you have an orchestrator of your own), in your own words, then answer the subagent with what they say.",
  "Only questions put to you can be answered here; anything else is refused and nothing is recorded.",
].join("\n\n")

/** What a session reads when it calls the tool that is not its own. */
export const HAS_ORCHESTRATOR = `You have an orchestrator: ask it with ${ASK_ORCHESTRATOR}.`
export const NO_ORCHESTRATOR = `You have no orchestrator: ask the owner with ${ASK_OWNER}.`

/** The tool a session asks with: a subagent its orchestrator, a root the owner. */
export const toolFor = (parent: Option.Option<string>): string => Option.match(parent, { onNone: () => ASK_OWNER, onSome: () => ASK_ORCHESTRATOR })

/** Why `tool` is not the session's to call, when it is not. */
export const wrongTool = (tool: string, parent: Option.Option<string>): Option.Option<string> =>
  Option.match(parent, {
    onNone: () => Option.liftPredicate(NO_ORCHESTRATOR, () => tool === ASK_ORCHESTRATOR),
    onSome: () => Option.liftPredicate(HAS_ORCHESTRATOR, () => tool === ASK_OWNER),
  })

/**
 * The nudge the questions' letter carries to the orchestrator: answer from the documents that exist (`paths`) and
 * the ledger, citing one; and whom to ask when they do not settle it: the owner for a root, its own orchestrator for
 * an orchestrator that has one.
 */
export const letterNudge = (paths: ReadonlyArray<string>, upward: Option.Option<string>): string =>
  [
    `Answer from the documents, not from memory alone, and cite the one you used: ${listed(paths, "the run's ledger (plan.md, your queue)")}.`,
    Option.match(upward, {
      onNone: () =>
        `If they do not settle it and it is the owner's to decide, ask the owner yourself with ${ASK_OWNER}, in your words and with the context they need, then answer the subagent with what they say.`,
      onSome: () =>
        `If they do not settle it and it is your orchestrator's to decide, ask your orchestrator yourself with ${ASK_ORCHESTRATOR}, in your words and with the context it needs, then answer the subagent with what it says.`,
    }),
  ].join("\n")

/** One question as `put` answers it. */
export const Opened = Schema.Struct({ id: Schema.String, question: Schema.String, assume: Schema.String })

/** What the questions plugin's `put` answers. */
export const Put = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.optional(Schema.String),
  opened: Schema.optional(Schema.Array(Opened)),
  closed: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String, reason: Schema.String }))),
})
export type Put = typeof Put.Type

/** What the questions plugin's `reply` answers. */
export const Reply = Schema.Struct({ ok: Schema.Boolean, message: Schema.optional(Schema.String) })
export type Reply = typeof Reply.Type

const CLOSED: ReadonlyArray<readonly [string, string]> = [
  ["withdrawn", "Withdrew"],
  ["superseded", "Replaced (asked again)"],
  ["dropped", `Dropped (more than ${MAX_OPEN} open)`],
]

/**
 * What the subagent reads after an ask: the ids and assumptions, that it goes on, and the nudge: check the documents
 * that exist (`paths`) and the ledger now, withdraw what they answer, and say next time what was checked.
 */
export const receipt = (put: Put, paths: ReadonlyArray<string>): string => {
  const opened = put.opened ?? []
  const closed = put.closed ?? []
  const asked = opened.length > 0
  return [
    ...["Asked your orchestrator in the background; it has not answered yet:"].filter(() => asked),
    ...opened.map((question) => `- ${question.id}: ${question.question} · assuming ${question.assume}`),
    ...CLOSED.flatMap(([reason, verb]) => {
      const ids = closed.filter((entry) => entry.reason === reason).map((entry) => entry.id)
      return [`${verb}: ${ids.join(", ")}.`].filter(() => ids.length > 0)
    }),
    ...[
      "Continue on your assumption now. Its answer arrives as a message in this session; if it differs, revise the work that rests on it.",
      `If you have not checked these, check them now, and withdraw the question if one answers it; next time say in the question what you checked: ${listed(paths, LEDGER)}.`,
    ].filter(() => asked),
  ].join("\n")
}
