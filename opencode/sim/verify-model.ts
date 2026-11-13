// The verify model: one scripted model a verifier drives by the words of its prompt, on both of the
// verify-opencode skill's paths. On the world it is `worldScript` (sim/verify-world.ts); on a real scratch
// OpenCode (`bun run verify:launch`) it answers OpenAI's chat completions, streamed, on a loopback port.
// This file imports `effect` alone, never the world: `scripts/verify.ts` imports it into the root project,
// whose type check must not reach the world's runtime or the fork's sources.
//
// A prompt says what the model does, one directive a line:
//
//   verify: call <tool> <json object>   call that tool with that input, in the order written
//   verify: say <text>                  after the calls, answer with that text (else a summary)
//
// Each request after the prompt makes the next call; once every call has its answer the model ends the
// turn with its `say`, or `verify: <n> call(s) done; the last answered: <its last line>`. A title request is
// answered `Verify run`. The same prompt does the same on both hosts, so a journey found on the world is
// typed into the real TUI word for word.
import { Array as Arr, Data, Match, Option, Predicate, Schema } from "effect"

/** A tool's input as a directive writes it: a JSON object. */
const Input = Schema.Record(Schema.String, Schema.Json)
type Input = typeof Input.Type

/** One thing a prompt asks the model for. */
export type Directive = Data.TaggedEnum<{
  Call: { readonly tool: string; readonly input: Input }
  Say: { readonly text: string }
}>
export const Directive = Data.taggedEnum<Directive>()

/** What the model answers: a tool call or the text that ends the turn. */
export type Answer = Data.TaggedEnum<{
  Call: { readonly id: string; readonly tool: string; readonly input: Input }
  Text: { readonly text: string }
}>
export const Answer = Data.taggedEnum<Answer>()

/** A conversation as the model reads it: the last prompt, the calls answered since, every call made so far, the newest answer. */
export interface Reading {
  readonly prompt: string
  readonly answered: number
  readonly calls: number
  readonly last: string
}

/** The title the model gives a conversation. */
export const TITLE = "Verify run"

const DIRECTIVE = /^verify: (call|say) ?(.*)$/
const CALL = /^(\S+)\s*(.*)$/
const decodeInput = Schema.decodeUnknownOption(Schema.fromJsonString(Input))
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** A match's group `at`, or the empty string. */
const groupOf = (match: RegExpExecArray, at: number): string => Option.getOrElse(Option.fromNullishOr(match[at]), () => "")

/** A directive line's call: the tool and its JSON object input (none written: `{}`); none when the input is no JSON object. */
const callOf = (rest: string): Option.Option<Directive> =>
  Option.flatMap(Option.fromNullishOr(CALL.exec(rest)), (match) =>
    Option.map(decodeInput(Option.getOrElse(Option.filter(Option.some(groupOf(match, 2)), (text) => text !== ""), () => "{}")), (input) =>
      Directive.Call({ tool: groupOf(match, 1), input }),
    ),
  )

/** One prompt line's directive, if it is one. */
const lineOf = (line: string): Option.Option<Directive> =>
  Option.flatMap(Option.fromNullishOr(DIRECTIVE.exec(line.trim())), (match) =>
    Match.value(groupOf(match, 1)).pipe(
      Match.when("say", () => Option.some(Directive.Say({ text: groupOf(match, 2) }))),
      Match.orElse(() => callOf(groupOf(match, 2))),
    ),
  )

/** The directives a prompt holds, in order; a line that is no directive, or a call whose input is no JSON object, is skipped. */
export const directives = (prompt: string): ReadonlyArray<Directive> => Arr.getSomes(prompt.split("\n").map(lineOf))

/** A text's last line that is not blank, cut to 200 characters. */
const lastLine = (text: string): string =>
  Option.getOrElse(Arr.last(Arr.filter(text.split("\n").map((line) => line.trim()), (line) => line !== "")), () => "nothing").slice(0, 200)

/** The turn's closing text once every call has its answer. */
const closing = (reading: Reading, said: Option.Option<string>, calls: number): Answer =>
  Option.match(said, {
    onSome: (text) => Answer.Text({ text }),
    onNone: () =>
      Match.value(calls).pipe(
        Match.when(0, () => Answer.Text({ text: `verify: no directive; you said ${lastLine(reading.prompt)}` })),
        Match.orElse((count) => Answer.Text({ text: `verify: ${count} call(s) done; the last answered: ${lastLine(reading.last)}` })),
      ),
  })

/** The model's answer to a conversation it reads as `reading`. */
export const answer = (reading: Reading): Answer => {
  const all = directives(reading.prompt)
  const calls = Arr.filter(all, Directive.$is("Call"))
  const said = Option.map(Arr.findFirst(all, Directive.$is("Say")), (say) => say.text)
  return Option.match(Arr.get(calls, reading.answered), {
    onSome: (next) => Answer.Call({ id: `verify_${reading.calls + 1}`, tool: next.tool, input: next.input }),
    onNone: () => closing(reading, said, calls.length),
  })
}

// ── On the world ──

/** A line that opens a message in the world's request text (sim/host.ts `renderOf`). */
const OPENS = /^(user: |synthetic: |assistant: |assistant call |tool |compaction: |error )/

/** One message of the world's request text: its opening words and its text. */
interface Rendered {
  readonly kind: string
  readonly text: string
}

/** The world's request text as its messages, in order: a line that opens none continues the one before. */
const worldMessages = (text: string): ReadonlyArray<Rendered> =>
  Arr.reduce(text.split("\n"), Arr.empty<Rendered>(), (messages, line) =>
    Option.match(Option.fromNullishOr(OPENS.exec(line)), {
      onSome: (opened) => Arr.append(messages, { kind: groupOf(opened, 1).trim(), text: line.slice(groupOf(opened, 1).length) }),
      onNone: () =>
        Option.match(Arr.last(messages), {
          onNone: () => messages,
          onSome: (open) => Arr.append(Arr.dropRight(messages, 1), { kind: open.kind, text: `${open.text}\n${line}` }),
        }),
    }),
  )

/** A reading of messages in order, by what marks the prompt, an answer and a call, and each one's text. */
const readingOf = <M>(messages: ReadonlyArray<M>, is: { readonly prompt: (m: M) => boolean; readonly answer: (m: M) => boolean; readonly calls: (m: M) => number; readonly text: (m: M) => string }): Reading => {
  const from = Arr.findLastIndex(messages, is.prompt)
  const since = Option.match(from, { onNone: () => messages, onSome: (at) => messages.slice(at + 1) })
  const answers = Arr.filter(since, is.answer)
  return {
    prompt: Option.getOrElse(Option.map(Option.flatMap(from, (at) => Arr.get(messages, at)), is.text), () => ""),
    answered: answers.length,
    calls: Arr.reduce(messages, 0, (sum, message) => sum + is.calls(message)),
    last: Option.getOrElse(Option.map(Arr.last(answers), is.text), () => ""),
  }
}

/** A world request read as the model reads it: the last prompt (`user:`), the answers since, every call so far. */
export const worldReading = (text: string): Reading =>
  readingOf(worldMessages(text), {
    prompt: (message) => message.kind === "user:",
    answer: (message) => message.kind === "tool",
    calls: (message) => Number(message.kind === "assistant call"),
    // A tool's line is `tool <callID> <name>: <output>`; a prompt's is its text.
    text: (message) => Match.value(message.kind).pipe(Match.when("tool", () => message.text.replace(/^\S+ \S+: /, "")), Match.orElse(() => message.text)),
  })

// ── On real OpenCode (OpenAI chat completions) ──

const Content = Schema.Union([Schema.String, Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) }))])
/** One chat message, as much of it as the model reads; an assistant's call carries no content, or `null`. */
const ChatMessage = Schema.Struct({
  role: Schema.String,
  content: Schema.OptionFromOptionalNullOr(Content),
  tool_calls: Schema.optional(Schema.Array(Schema.Unknown)),
})
type ChatMessage = typeof ChatMessage.Type

/** A chat completions request, as much of it as the model reads. */
export const ChatRequest = Schema.Struct({
  model: Schema.optional(Schema.String),
  messages: Schema.optional(Schema.Array(ChatMessage)),
})
export type ChatRequest = typeof ChatRequest.Type

/** A chat message's text: its string, or its parts' texts. */
const textOf = (message: ChatMessage): string =>
  Option.match(message.content, {
    onNone: () => "",
    onSome: (content) => Match.value(content).pipe(
      Match.when(Predicate.isString, (text) => text),
      Match.orElse((parts) => parts.map((part) => Option.getOrElse(Option.fromNullishOr(part.text), () => "")).join("")),
    ),
  })

const messagesOf = (request: ChatRequest): ReadonlyArray<ChatMessage> => Option.getOrElse(Option.fromNullishOr(request.messages), () => [])

/** A chat request read as the model reads it. */
export const chatReading = (request: ChatRequest): Reading =>
  readingOf(messagesOf(request), {
    prompt: (message) => message.role === "user",
    answer: (message) => message.role === "tool",
    calls: (message) => Option.getOrElse(Option.map(Option.fromNullishOr(message.tool_calls), (calls) => calls.length), () => 0),
    text: textOf,
  })

/** Whether a chat request is OpenCode asking for a title (its system prompt names conversations). */
export const asksTitle = (request: ChatRequest): boolean =>
  messagesOf(request).some((message) => message.role === "system" && textOf(message).includes("You name conversations"))

/** The model's answer to a chat request. */
export const chatAnswer = (request: ChatRequest): Answer =>
  Match.value(asksTitle(request)).pipe(
    Match.when(true, () => Answer.Text({ text: TITLE })),
    Match.orElse(() => answer(chatReading(request))),
  )

/** An answer's chunks of one streamed chat completion, after the opening one. */
const bodyOf = (reply: Answer, chunk: (delta: Input, finish: Option.Option<string>) => Schema.Json): ReadonlyArray<Schema.Json> =>
  Answer.$match(reply, {
    Text: (text) => [...text.text.split(/(?<= )/).map((word) => chunk({ content: word }, Option.none())), chunk({}, Option.some("stop"))],
    Call: (call) => [
      chunk({ tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.tool, arguments: encodeJson(call.input) } }] }, Option.none()),
      chunk({}, Option.some("tool_calls")),
    ],
  })

/**
 * The events that answer a chat request's body (JSON): what `verify:launch`'s model serves. A body that is no chat
 * request reads as one with no messages. It takes and gives plain strings, so a caller on another `effect` (the
 * root's scripts) never meets this package's schemas.
 */
export const chatResponse = (body: string, id: string): ReadonlyArray<string> => {
  const request = Option.getOrElse(Schema.decodeUnknownOption(Schema.fromJsonString(ChatRequest))(body), (): ChatRequest => ({}))
  return chatEvents(chatAnswer(request), Option.getOrElse(Option.fromNullishOr(request.model), () => "sim-model"), id)
}

/** An answer as the server-sent events of one streamed chat completion, `data: [DONE]` last. */
export const chatEvents = (reply: Answer, model: string, id: string): ReadonlyArray<string> => {
  const chunk = (delta: Input, finish: Option.Option<string>): Schema.Json => ({
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: Option.getOrNull(finish) }],
  })
  const usage = { id, object: "chat.completion.chunk", created: 0, model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }
  return [...[chunk({ role: "assistant", content: "" }, Option.none()), ...bodyOf(reply, chunk), usage].map((event) => `data: ${encodeJson(event)}\n\n`), "data: [DONE]\n\n"]
}
