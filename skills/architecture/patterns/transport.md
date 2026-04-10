# Transport Abstraction Pattern

Decouple business logic from transport layer. Core emits protocol-agnostic events; clients interpret for their transport.

## Core Principle

```
┌─────────────────────────────────────┐
│         BUSINESS LOGIC              │
│   (yields protocol-agnostic events) │
└────────────────┬────────────────────┘
                 │
         AgentEvent stream
                 │
    ┌────────────┴────────────┐
    │                         │
┌───▼───┐  ┌───▼───┐  ┌──▼───┐
│  TUI  │  │  Web  │  │ Slack│
│render │  │stream │  │ post │
└───────┘  └───────┘  └──────┘
```

## Event Protocol

```typescript
// Core event types - transport-agnostic
type AgentEvent =
  | { type: "message.start"; messageId: string }
  | { type: "message.delta"; messageId: string; content: string }
  | { type: "message.complete"; messageId: string }
  | { type: "tool.start"; toolId: string; name: string; input: unknown }
  | { type: "tool.result"; toolId: string; output: unknown }
  | { type: "error"; error: string }
  | { type: "done" }

// Core yields events - doesn't know about transport
function* runAgent(input: string): Generator<AgentEvent> {
  yield { type: "message.start", messageId: "msg-1" }

  for (const chunk of llm.stream(input)) {
    yield { type: "message.delta", messageId: "msg-1", content: chunk }
  }

  yield { type: "message.complete", messageId: "msg-1" }
  yield { type: "done" }
}
```

## Effect-Based Agent Loop

```typescript
import { Effect, Stream } from "effect"

// Agent service yields event stream
export class AgentService extends Context.Service<
  AgentService,
  {
    readonly run: (input: string) => Stream.Stream<AgentEvent, AgentError>
  }
>()("AgentService") {
  static layer = Layer.effect(
    AgentService,
    Effect.gen(function* () {
      const llm = yield* LlmService
      const tools = yield* ToolService

      return AgentService.of({
        run: (input) =>
          Stream.asyncEffect<AgentEvent, AgentError>((emit) =>
            Effect.gen(function* () {
              const messageId = crypto.randomUUID()
              yield* emit.single({ type: "message.start", messageId })

              const stream = yield* llm.stream(input)

              for await (const chunk of stream) {
                if (chunk.type === "text") {
                  yield* emit.single({
                    type: "message.delta",
                    messageId,
                    content: chunk.text,
                  })
                } else if (chunk.type === "tool_use") {
                  const toolId = chunk.id
                  yield* emit.single({
                    type: "tool.start",
                    toolId,
                    name: chunk.name,
                    input: chunk.input,
                  })

                  const result = yield* tools.execute(chunk.name, chunk.input)
                  yield* emit.single({ type: "tool.result", toolId, output: result })
                }
              }

              yield* emit.single({ type: "message.complete", messageId })
              yield* emit.single({ type: "done" })
            })
          ),
      })
    })
  )
}
```

## TUI Transport

```typescript
// TUI renders events to terminal
import { render, Text, Box } from "@opentui/solid"
import { createSignal } from "solid-js"

function AgentTUI() {
  const [messages, setMessages] = createSignal<Map<string, string>>(new Map())
  const [currentTool, setCurrentTool] = createSignal<string | null>(null)

  // Subscribe to agent events
  onMount(() => {
    const agent = yield* AgentService

    Stream.runForEach(agent.run(input), (event) =>
      Effect.sync(() => {
        switch (event.type) {
          case "message.delta":
            setMessages((prev) => {
              const updated = new Map(prev)
              const current = updated.get(event.messageId) ?? ""
              updated.set(event.messageId, current + event.content)
              return updated
            })
            break
          case "tool.start":
            setCurrentTool(`Running ${event.name}...`)
            break
          case "tool.result":
            setCurrentTool(null)
            break
        }
      })
    )
  })

  return (
    <Box flexDirection="column">
      <For each={[...messages().entries()]}>
        {([id, content]) => <Text>{content}</Text>}
      </For>
      <Show when={currentTool()}>
        <Text color="yellow">{currentTool()}</Text>
      </Show>
    </Box>
  )
}
```

## Web/SSE Transport

```typescript
// Server: stream events via SSE
export const AgentGroupLive = HttpApiBuilder.group(AppApi, "agent", (handlers) =>
  Effect.gen(function* () {
    const agent = yield* AgentService

    return handlers.handle("stream", ({ input }) =>
      Effect.gen(function* () {
        const events = agent.run(input)

        return HttpServerResponse.stream(
          events.pipe(
            Stream.map((event) => `data: ${JSON.stringify(event)}\n\n`)
          ),
          { contentType: "text/event-stream" }
        )
      })
    )
  })
)

// Client: consume SSE
function useAgentStream(input: string) {
  const [state, setState] = createSignal<AgentState>({ messages: new Map() })

  onMount(() => {
    const eventSource = new EventSource(`/api/agent/stream?input=${input}`)

    eventSource.onmessage = (e) => {
      const event: AgentEvent = JSON.parse(e.data)
      setState((prev) => reduceAgentEvent(prev, event))
    }

    onCleanup(() => eventSource.close())
  })

  return state
}
```

## WebSocket Transport

```typescript
// Bidirectional communication for interactive sessions
export const AgentWsHandler = HttpApiBuilder.ws(AppApi, "agentWs", (handlers) =>
  Effect.gen(function* () {
    const agent = yield* AgentService

    return handlers.handle((socket) =>
      Effect.gen(function* () {
        // Receive input from client
        const input = yield* socket.receive()

        // Stream events back
        yield* Stream.runForEach(agent.run(input.text), (event) =>
          socket.send(JSON.stringify(event))
        )
      })
    )
  })
)
```

## Slack Bot Transport

```typescript
// Slack interprets events as message updates
async function handleSlackMessage(event: SlackEvent) {
  const agent = await runAgentService()
  const channel = event.channel
  let messageTs: string | undefined

  for await (const agentEvent of agent.run(event.text)) {
    switch (agentEvent.type) {
      case "message.start":
        const result = await slack.chat.postMessage({
          channel,
          text: "Thinking...",
        })
        messageTs = result.ts
        break

      case "message.delta":
        // Accumulate and update periodically (Slack rate limits)
        break

      case "message.complete":
        await slack.chat.update({
          channel,
          ts: messageTs!,
          text: accumulatedContent,
        })
        break

      case "tool.start":
        await slack.chat.postMessage({
          channel,
          text: `🔧 Running ${agentEvent.name}...`,
        })
        break
    }
  }
}
```

## Proxy Transport (Remote LLM)

```typescript
// Proxy through remote server for web clients without API keys
export function streamProxy(
  model: string,
  messages: Message[],
  options: { proxyUrl: string }
): AsyncIterable<AgentEvent> {
  const response = await fetch(options.proxyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages }),
  })

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()

  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const lines = decoder.decode(value).split("\n")
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            yield JSON.parse(line.slice(6)) as AgentEvent
          }
        }
      }
    },
  }
}
```

## Key Benefits

1. **Single source of logic**: Agent loop written once, used everywhere
2. **Client flexibility**: Each client renders events appropriately
3. **Testable**: Mock event stream for UI testing
4. **Extensible**: Add new transports without changing core
5. **Type-safe**: Event protocol enforced across boundaries

## Best Practices

1. **Keep events granular**: Small events enable responsive UIs
2. **Include IDs**: Allow correlating related events (messageId, toolId)
3. **Don't leak transport details**: Core shouldn't know about HTTP/WS/etc.
4. **Buffer appropriately**: Batch updates for rate-limited transports (Slack)
5. **Handle backpressure**: Clients may process slower than core emits
