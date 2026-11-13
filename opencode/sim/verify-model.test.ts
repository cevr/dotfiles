// The verify model (verify-model.ts): what a prompt's directives make it do, read off the world's request
// text and off an OpenAI chat request alike, and the stream it answers a real OpenCode with.
import { describe, expect, test } from "bun:test"
import { Option, Predicate, Schema } from "effect"
import { Answer, answer, chatAnswer, chatEvents, chatReading, ChatRequest, chatResponse, Directive, directives, TITLE, worldReading } from "./verify-model.ts"

const PROMPT = ['verify: call queue {"set":[{"id":"a","text":"A","state":"next"}]}', "verify: call sessions", "some words between", "verify: say all done"].join("\n")
const decodeChat = Schema.decodeUnknownSync(Schema.fromJsonString(
  Schema.Struct({ choices: Schema.Array(Schema.Struct({ delta: Schema.Struct({ content: Schema.optional(Schema.String), tool_calls: Schema.optional(Schema.Array(Schema.Unknown)) }), finish_reason: Schema.NullOr(Schema.String) })) })),
)

describe("the directives", () => {
  test("a prompt's calls and say, in order; other lines and a call whose input is no JSON object are skipped", () => {
    expect(directives(`${PROMPT}\nverify: call broken {not json}\nverify: call list [1]`)).toEqual([
      Directive.Call({ tool: "queue", input: { set: [{ id: "a", text: "A", state: "next" }] } }),
      Directive.Call({ tool: "sessions", input: {} }),
      Directive.Say({ text: "all done" }),
    ])
  })

  test("each answered call makes the next, then the say ends the turn", () => {
    const reading = { prompt: PROMPT, answered: 0, calls: 3, last: "" }
    expect(answer(reading)).toEqual(Answer.Call({ id: "verify_4", tool: "queue", input: { set: [{ id: "a", text: "A", state: "next" }] } }))
    expect(answer({ ...reading, answered: 1, calls: 4 })).toEqual(Answer.Call({ id: "verify_5", tool: "sessions", input: {} }))
    expect(answer({ ...reading, answered: 2, calls: 5 })).toEqual(Answer.Text({ text: "all done" }))
  })

  test("without a say, the turn ends naming the calls and the last answer's last line; without directives, the prompt's", () => {
    expect(answer({ prompt: "verify: call sessions", answered: 1, calls: 1, last: "Sessions:\nses_1 \"A\" · idle\n" })).toEqual(
      Answer.Text({ text: 'verify: 1 call(s) done; the last answered: ses_1 "A" · idle' }),
    )
    expect(answer({ prompt: "hello there", answered: 0, calls: 0, last: "" })).toEqual(Answer.Text({ text: "verify: no directive; you said hello there" }))
  })
})

describe("on the world", () => {
  test("the request text reads as the last prompt, the answers since it, and every call so far", () => {
    const text = [
      "user: verify: call sessions",
      "assistant call verify_1 sessions {}",
      "tool verify_1 sessions: Sessions:\nses_1 idle",
      "assistant: verify: 1 call(s) done; the last answered: ses_1 idle",
      `user: ${PROMPT}`,
      'assistant call verify_2 queue {"set":[]}',
      "tool verify_2 queue: Queue (1):\n○ a [next]: A",
    ].join("\n")
    expect(worldReading(text)).toEqual({ prompt: PROMPT, answered: 1, calls: 2, last: "Queue (1):\n○ a [next]: A" })
  })
})

describe("on real OpenCode", () => {
  test("a chat request reads the same way, and a title request is answered with the title", () => {
    // The wire as OpenAI writes it: an assistant's call carries `content: null`.
    const request = Schema.decodeUnknownSync(Schema.fromJsonString(ChatRequest))(
      '{"model":"sim-model","messages":[{"role":"system","content":"You are OpenCode"},{"role":"user","content":[{"text":"verify: call sessions"}]},{"role":"assistant","content":null,"tool_calls":[{"id":"verify_1"}]},{"role":"tool","content":"Sessions:\\nses_1 idle"}]}',
    )
    expect(chatReading(request)).toEqual({ prompt: "verify: call sessions", answered: 1, calls: 1, last: "Sessions:\nses_1 idle" })
    expect(chatAnswer(request)).toEqual(Answer.Text({ text: "verify: 1 call(s) done; the last answered: ses_1 idle" }))
    expect(chatAnswer(Schema.decodeUnknownSync(ChatRequest)({ messages: [{ role: "system", content: "You name conversations" }] }))).toEqual(Answer.Text({ text: TITLE }))
  })

  test("a call streams as one tool-call chunk and a text as its words, each ending [DONE]", () => {
    const call = chatEvents(Answer.Call({ id: "verify_1", tool: "queue", input: { set: [] } }), "sim-model", "c1")
    const text = chatEvents(Answer.Text({ text: "two words" }), "sim-model", "c2")
    expect([call.at(-1), text.at(-1)]).toEqual(["data: [DONE]\n\n", "data: [DONE]\n\n"])
    const chunks = (events: ReadonlyArray<string>) => events.slice(0, -1).map((event) => decodeChat(event.slice("data: ".length)))
    const finishes = (events: ReadonlyArray<string>) => chunks(events).flatMap((chunk) => chunk.choices.map((choice) => choice.finish_reason)).filter(Predicate.isNotNull)
    expect([finishes(call), finishes(text)]).toEqual([["tool_calls"], ["stop"]])
    expect(chunks(text).flatMap((chunk) => chunk.choices.map((choice) => Option.getOrElse(Option.fromNullishOr(choice.delta.content), () => ""))).join("")).toBe("two words")
    expect(chunks(call)[1]?.choices[0]?.delta.tool_calls).toEqual([{ index: 0, id: "verify_1", type: "function", function: { name: "queue", arguments: '{"set":[]}' } }])
  })

  test("the served body answers its prompt, and a body that is no chat request reads as an empty one", () => {
    const said = (events: ReadonlyArray<string>) =>
      events
        .slice(0, -1)
        .flatMap((event) => decodeChat(event.slice("data: ".length)).choices.map((choice) => Option.getOrElse(Option.fromNullishOr(choice.delta.content), () => "")))
        .join("")
    expect(said(chatResponse('{"messages":[{"role":"user","content":"verify: say hi there"}]}', "r1"))).toBe("hi there")
    expect(said(chatResponse("not json", "r2"))).toBe("verify: no directive; you said nothing")
  })
})
