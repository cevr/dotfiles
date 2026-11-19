// The orchestrator tools for questions, installed on OpenCode's plugin context
// (asking.ts has the words): `ask_orchestrator` and `answer_subagent`, which
// call the questions plugin's `put` and `reply`; the swap, so a subagent asks
// its orchestrator and a root the owner; and the documents each side is
// nudged to check.
//
// The swap holds twice. Each agent of mode `subagent` gets a deny of
// `ask_user_async`, and each of mode `primary` a deny of `ask_orchestrator`,
// pushed last: OpenCode's rules match last-first (packages/core/src/tool.ts
// `whollyDisabled`, permission.ts `evaluate`, both `findLast`), so a role's
// earlier allow does not undo it; an agent of mode `all` keeps both. And
// whatever the agent, a call of the wrong one is refused before it runs
// (`execute.before`), naming the right one: the session's parent decides.
import { type Plugin, Tool } from "@opencode/plugin/effect"
import { Effect, Option, Schema } from "effect"
import {
  ANSWER_SUBAGENT,
  ANSWER_SUBAGENT_DESCRIPTION,
  ASK_ORCHESTRATOR,
  ASK_ORCHESTRATOR_DESCRIPTION,
  ASK_OWNER,
  AnswerSubagentInput,
  AskOrchestratorInput,
  letterNudge,
  NO_ORCHESTRATOR,
  Put,
  Reply,
  receipt,
  wrongTool,
} from "../asking.ts"
import { documents, type Look } from "../documents.ts"

/** The questions plugin's RPC, as far as the tools call it. */
export interface Questions {
  readonly put: (input: {
    readonly sessionID: string
    readonly to: string
    readonly nudge: string
    readonly questions?: AskOrchestratorInput["questions"]
    readonly withdraw?: AskOrchestratorInput["withdraw"]
  }) => Effect.Effect<unknown, unknown>
  readonly reply: (input: { readonly by: string; readonly answers: AnswerSubagentInput["answers"] }) => Effect.Effect<unknown, unknown>
}

/** Who a session is, as far as the tools read it: its parent, and the directory it works in. */
export interface Family {
  readonly parentOf: (sessionID: string) => Effect.Effect<Option.Option<string>>
  readonly directoryOf: (sessionID: string) => Effect.Effect<string>
}

/** Where the documents are found: what exists. */
export interface Docs {
  readonly look: Look
}

const failWith = (message: string) => Effect.fail(new Tool.Error({ message }))

const decodePut = Schema.decodeUnknownOption(Put)
const decodeReply = Schema.decodeUnknownOption(Reply)

/** The answer's text, or the questions plugin's refusal as the tool's failure. */
const answered = <A extends { readonly ok: boolean; readonly message?: string }>(answer: Option.Option<A>, text: (done: A) => string) =>
  Option.match(answer, {
    onNone: () => failWith("The questions plugin gave no answer it could read; nothing was asked."),
    onSome: (done) => Option.match(Option.liftPredicate(done, (reply) => reply.ok), { onNone: () => failWith(done.message ?? "Refused."), onSome: (ok) => Effect.succeed(text(ok)) }),
  })

const textOf = (text: string) => ({ content: [{ type: "text" as const, text }] })

/** Register the two tools, the agents' swap and the refusal of the wrong tool. */
export const install = Effect.fn("Asking.install")(function* (ctx: Plugin.Context, questions: Questions, family: Family, docs: Docs) {
  const documentsOf = (sessionID: string) => Effect.flatMap(family.directoryOf(sessionID), (directory) => documents(docs.look, directory))

  const ask = Effect.fn("Asking.ask")(function* (sessionID: string, input: AskOrchestratorInput) {
    const parent = yield* family.parentOf(sessionID)
    if (Option.isNone(parent)) return yield* failWith(NO_ORCHESTRATOR)
    const paths = yield* documentsOf(sessionID)
    const nudge = letterNudge(paths, yield* family.parentOf(parent.value))
    const answer = yield* questions.put({ sessionID, to: parent.value, nudge, ...input }).pipe(Effect.orElseSucceed(() => ({ ok: false, message: "The questions plugin did not answer; nothing was asked." })))
    return yield* answered(decodePut(answer), (put) => receipt(put, paths))
  })

  const answer = Effect.fn("Asking.answer")(function* (sessionID: string, input: AnswerSubagentInput) {
    const reply = yield* questions.reply({ by: sessionID, answers: input.answers }).pipe(Effect.orElseSucceed(() => ({ ok: false, message: "The questions plugin did not answer; nothing was answered." })))
    return yield* answered(decodeReply(reply), (done) => done.message ?? "Answered.")
  })

  yield* ctx.tool.transform((editor) => {
    editor.add({
      name: ASK_ORCHESTRATOR,
      description: ASK_ORCHESTRATOR_DESCRIPTION,
      input: AskOrchestratorInput,
      options: { codemode: false },
      execute: (input, context) => Effect.map(ask(context.sessionID, input), textOf),
    })
    editor.add({
      name: ANSWER_SUBAGENT,
      description: ANSWER_SUBAGENT_DESCRIPTION,
      input: AnswerSubagentInput,
      options: { codemode: false },
      execute: (input, context) => Effect.map(answer(context.sessionID, input), textOf),
    })
  })

  yield* ctx.agent.transform((editor) => {
    for (const agent of editor.list()) {
      const denied = [[ASK_OWNER].filter(() => agent.mode === "subagent"), [ASK_ORCHESTRATOR].filter(() => agent.mode === "primary")].flat()
      if (denied.length > 0)
        editor.update(agent.id, (item) => {
          item.permissions.push(...denied.map((action) => ({ action, resource: "*", effect: "deny" as const })))
        })
    }
  })

  yield* ctx.tool.hook("execute.before", (event) => {
    if (event.tool !== ASK_OWNER && event.tool !== ASK_ORCHESTRATOR) return Effect.void
    return Effect.flatMap(family.parentOf(event.sessionID), (parent) =>
      Option.match(wrongTool(event.tool, parent), { onNone: () => Effect.void, onSome: (why) => failWith(why) }),
    )
  })
})
