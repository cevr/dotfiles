// The scripted model for the work test (tests/work.test.ts): an OpenAI-compatible chat endpoint that answers by
// the conversation it is sent, served by tests/work/run.ts on a loopback port. Each request is kept for the test.
// Each next call comes once the last one's result is back.
//
// - A title request: a short title.
// - `work flow`: create a workspace for `feat/x` with `work`; commit in it through the shell; list; remove it
//   (refused: the commit is found nowhere else); remove it with force; then a closing line.
// - `work land`: create a workspace for `feat/x`; commit a file in it through the shell; land it by
//   `workspaces`; then a closing line, again after the wake.
// - `work alias`: list with the alias `rift`; then a closing line.
// - Anything else: one line.
import { Effect, Option, Predicate, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"

export const FLOW = "work flow"
export const LAND = "work land"
export const ALIAS = "work alias"
export const DONE = "sim: work done"
export const BRANCH = "feat/x"
export const COMMIT_SUBJECT = "only here"
export const LAND_SUBJECT = "feat: land me"

/**
 * The names the test looks for in each request: the worktree tools, and a sibling of theirs that stays, the
 * session move tool. Code Mode calls it `opencode.session_move` up to the fork's upstream merge of 8e50929d0d
 * and `opencode.session.move` from it (`opencode_session_move` without Code Mode, before and after).
 */
export const WATCHED = ["worktree_create", "worktree_list", "worktree_remove", "session_move", "session.move"]

/**
 * What a request names of WATCHED: its worktree names, and whether it names the session move tool (either name;
 * a later request may carry both, the work answer naming `opencode_session_move` beside Code Mode's catalog).
 */
export const watchedIn = (named: ReadonlyArray<string>) => ({
  worktree: named.filter((name) => name.startsWith("worktree_")),
  move: named.some((name) => !name.startsWith("worktree_")),
})

/** What the test reads back about one request. */
export const Seen = Schema.Struct({
  task: Schema.String,
  tools: Schema.Array(Schema.String),
  /** Which watched names the whole request carries anywhere (a tool, Code Mode's catalog, the system prompt). */
  named: Schema.Array(Schema.String),
})
export type Seen = typeof Seen.Type

/** What one tool call of the session said. */
export const Call = Schema.Struct({ name: Schema.String, status: Schema.String, said: Schema.String })
export type Call = typeof Call.Type

/** What a run writes: its tool calls, the transcript as JSON, the model's requests and the paths and state after it. */
export const Result = Schema.Struct({
  calls: Schema.Array(Call),
  transcript: Schema.String,
  seen: Schema.Array(Seen),
  /** The base, as work names it. */
  source: Schema.String,
  /** Where the workspace for the branch is made. */
  workspace: Schema.String,
  /** Where the land's integration workspace is made. */
  integration: Schema.String,
  /** The subject of the bare origin's main after the run. */
  originMain: Schema.String,
  workspaceThere: Schema.Boolean,
  integrationThere: Schema.Boolean,
})
export type Result = typeof Result.Type

/** A tool call's input, as the script writes it. */
type Input = { readonly [field: string]: string | boolean | ReadonlyArray<string> }

/** One step of a script: a text, or a tool call. */
type Reply = { readonly kind: "text"; readonly text: string } | { readonly kind: "tool"; readonly name: string; readonly input: Input }

/** A message's content: a string or its parts. */
const Content = Schema.Union([Schema.String, Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) }))])
type Content = typeof Content.Type
const ChatRequest = Schema.Struct({
  model: Schema.optional(Schema.String),
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.OptionFromOptionalNullOr(Content) })),
  tools: Schema.optional(Schema.Array(Schema.Struct({ function: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String) })) }))),
})
type ChatRequest = typeof ChatRequest.Type
const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(ChatRequest))
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const textOf = (content: Option.Option<Content>): string =>
  Option.match(content, {
    onNone: () => "",
    onSome: (present) => {
      if (Predicate.isString(present)) return present
      return present.map((part) => Option.getOrElse(Option.fromUndefinedOr(part.text), () => "")).join("")
    },
  })

const commit = (subject: string, workspace: string, first: string): Reply => ({
  kind: "tool",
  name: "shell",
  input: {
    command: `${first}git -c user.name=sim -c user.email=sim@example.com -c commit.gpgsign=false commit --allow-empty -q -m "${subject}"`,
    workdir: workspace,
    description: "Commit in the workspace",
  },
})

/** Each task's calls, for a workspace that will be made at `workspace`. */
const scripts = (workspace: string): ReadonlyArray<readonly [string, ReadonlyArray<Reply>]> => [
  [
    FLOW,
    [
      { kind: "tool", name: "work", input: { action: "create", branch: BRANCH } },
      commit(COMMIT_SUBJECT, workspace, ""),
      { kind: "tool", name: "work", input: { action: "list" } },
      { kind: "tool", name: "work", input: { action: "remove", name: "feat-x" } },
      { kind: "tool", name: "work", input: { action: "remove", name: "feat-x", force: true } },
    ],
  ],
  [
    LAND,
    [
      { kind: "tool", name: "work", input: { action: "create", branch: BRANCH } },
      commit(LAND_SUBJECT, workspace, "echo landed > landed.txt && git add landed.txt && "),
      { kind: "tool", name: "work", input: { action: "land", workspaces: ["feat-x"] } },
    ],
  ],
  [ALIAS, [{ kind: "tool", name: "rift", input: { action: "list" } }]],
]

/** The reply to a request: the next step of its task's script, by how many tool results came back. */
const replyTo = (request: ChatRequest, workspace: string): Reply => {
  const system = request.messages.filter((message) => message.role === "system").map((message) => textOf(message.content))
  if (system.join("\n").includes("You name conversations")) return { kind: "text", text: "Work run" }
  const task = textOf(Option.flatMap(Option.fromUndefinedOr(request.messages.find((message) => message.role === "user")), (message) => message.content)).trim()
  return Option.match(Option.fromUndefinedOr(scripts(workspace).find(([name]) => task.endsWith(name))), {
    onNone: (): Reply => ({ kind: "text", text: "sim: nothing to do" }),
    onSome: ([, steps]) => Option.getOrElse(Option.fromUndefinedOr(steps[request.messages.filter((message) => message.role === "tool").length]), (): Reply => ({ kind: "text", text: DONE })),
  })
}

/** One stream event's delta: the role, a text, or a tool call. */
interface Delta {
  readonly role?: string
  readonly content?: string
  readonly tool_calls?: ReadonlyArray<{ readonly index: number; readonly id: string; readonly type: string; readonly function: { readonly name: string; readonly arguments: string } }>
}

/** The reply as OpenAI-compatible stream events, with a usage. */
const events = (reply: Reply, model: string, id: string): string => {
  const chunk = (delta: Delta, finish: Option.Option<string>) => ({ id, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: Option.getOrUndefined(finish) }] })
  const bodyOf = (answer: Reply) => {
    if (answer.kind === "text") return [chunk({ content: answer.text }, Option.none()), chunk({}, Option.some("stop"))]
    return [
      chunk({ tool_calls: [{ index: 0, id: `call_${id}`, type: "function", function: { name: answer.name, arguments: toJson(answer.input) } }] }, Option.none()),
      chunk({}, Option.some("tool_calls")),
    ]
  }
  const body = bodyOf(reply)
  const usage = { id, object: "chat.completion.chunk", created: 0, model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }
  return [...[chunk({ role: "assistant", content: "" }, Option.none()), ...body, usage].map((event) => `data: ${toJson(event)}\n\n`), "data: [DONE]\n\n"].join("")
}

/** The scripted model's handler for a workspace that will be made at `workspace`; each request is kept in `seen`. */
export const model = (workspace: string, seen: Array<Seen>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (request.method !== "POST" || !request.url.endsWith("/chat/completions")) return HttpServerResponse.text("not found", { status: 404 })
    const raw = yield* request.text
    const body = yield* decodeRequest(raw)
    const task = textOf(Option.flatMap(Option.fromUndefinedOr(body.messages.find((message) => message.role === "user")), (message) => message.content)).trim()
    const tools = Option.getOrElse(Option.fromUndefinedOr(body.tools), () => [])
    seen.push({
      task,
      tools: tools.map((tool) => Option.getOrElse(Option.fromUndefinedOr(tool.function?.name), () => "")),
      named: WATCHED.filter((name) => raw.includes(name)),
    })
    return HttpServerResponse.text(events(replyTo(body, workspace), Option.getOrElse(Option.fromUndefinedOr(body.model), () => "sim"), `sim${seen.length}`), {
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" },
    })
  }).pipe(Effect.orDie)
