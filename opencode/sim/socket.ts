// A reply as a provider streams it over a WebSocket: OpenAI's Responses events,
// one frame each, as the fork's socket transport reads them (packages/ai's
// open-responses-channel.ts) and runs `experimental.ws.receive` on each. The
// world builds them from the script's reply, so a plugin that reads a socket's
// frames (the pool reads a ChatGPT login's quota from them) reads what the
// real host hands it. Held to real OpenCode by the socket law (host-laws.ts).
import { Array as Arr, Schema } from "effect"
import type { Item, Reply, Usage } from "./host.ts"

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

/** The events an item streams as, under the response's message `message`; a reasoning delta and the rest of a tool call stream as nothing. */
const eventsOf = (item: Item, message: string): ReadonlyArray<Schema.Json> => {
  switch (item.type) {
    case "textDelta":
      return [{ type: "response.output_text.delta", item_id: message, delta: item.text }]
    case "toolCall":
      return [
        {
          type: "response.output_item.done",
          item: { type: "function_call", id: `fc_${item.id}`, call_id: item.id, name: item.name, arguments: encode(item.input), status: "completed" },
        },
      ]
    case "reasoningDelta":
    case "toolInputStart":
    case "toolInputDelta":
    case "raw":
      return []
  }
}

/**
 * The frames of `reply` as response `id`: `response.created`, the message's text, each tool call, then
 * `response.completed` with the usage (its cache read inside the input, as Responses counts it).
 */
export const framesOf = (reply: Reply, id: string, usage: Usage): ReadonlyArray<string> => {
  const message = `msg_${id}`
  const deltas = reply.items.filter((item) => item.type === "textDelta")
  const text = deltas.map((item) => item.text).join("")
  const said = Arr.filter([deltas], () => text !== "").flatMap((items): ReadonlyArray<Schema.Json> => [
    { type: "response.output_item.added", item: { type: "message", id: message } },
    ...items.flatMap((item) => eventsOf(item, message)),
    { type: "response.output_text.done", item_id: message, text },
  ])
  const calls = reply.items.filter((item) => item.type === "toolCall").flatMap((item) => eventsOf(item, message))
  const total = usage.input + usage.read + usage.write
  const events: ReadonlyArray<Schema.Json> = [
    { type: "response.created", response: { id } },
    ...said,
    ...calls,
    {
      type: "response.completed",
      response: { id, usage: { input_tokens: total, input_tokens_details: { cached_tokens: usage.read }, output_tokens: 0, total_tokens: total } },
    },
  ]
  return events.map((event) => encode(event))
}
