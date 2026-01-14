# Bot Client

Bot integration adapter for Slack, Discord, and other messaging platforms.

## Package Setup

```json
// apps/bot/package.json
{
  "name": "@my-app/bot",
  "type": "module",
  "scripts": {
    "dev": "bun run --watch src/main.ts",
    "start": "bun run src/main.ts"
  },
  "dependencies": {
    "@my-app/api": "workspace:*",
    "@my-app/shared": "workspace:*",
    "effect": "^3.0.0",
    "@effect/platform": "^0.77.0",
    "@slack/bolt": "^3.17.0",
    "discord.js": "^14.14.0"
  }
}
```

## Bot Service Interface

```typescript
// apps/bot/src/bot.ts
import { Context, Effect, Layer } from "effect"

export interface BotMessage {
  platform: "slack" | "discord"
  channelId: string
  userId: string
  text: string
  threadId?: string
}

export interface BotResponse {
  text: string
  blocks?: unknown[]  // Platform-specific rich content
}

export class BotService extends Context.Tag("BotService")<
  BotService,
  {
    readonly sendMessage: (
      channelId: string,
      response: BotResponse
    ) => Effect.Effect<void>
    readonly sendThreadReply: (
      channelId: string,
      threadId: string,
      response: BotResponse
    ) => Effect.Effect<void>
    readonly updateMessage: (
      channelId: string,
      messageId: string,
      response: BotResponse
    ) => Effect.Effect<void>
  }
>() {}
```

## Slack Adapter

```typescript
// apps/bot/src/adapters/slack.ts
import { App, type SlackEventMiddlewareArgs } from "@slack/bolt"
import { Effect, Layer, Queue, Config } from "effect"
import { BotService, type BotMessage, type BotResponse } from "../bot"

export const SlackBotLive = Layer.effect(
  BotService,
  Effect.gen(function* () {
    const token = yield* Config.string("SLACK_BOT_TOKEN")
    const signingSecret = yield* Config.string("SLACK_SIGNING_SECRET")
    const appToken = yield* Config.string("SLACK_APP_TOKEN")

    const app = new App({
      token,
      signingSecret,
      socketMode: true,
      appToken,
    })

    return BotService.of({
      sendMessage: (channelId, response) =>
        Effect.tryPromise(() =>
          app.client.chat.postMessage({
            channel: channelId,
            text: response.text,
            blocks: response.blocks as any,
          })
        ).pipe(Effect.asVoid),

      sendThreadReply: (channelId, threadId, response) =>
        Effect.tryPromise(() =>
          app.client.chat.postMessage({
            channel: channelId,
            thread_ts: threadId,
            text: response.text,
            blocks: response.blocks as any,
          })
        ).pipe(Effect.asVoid),

      updateMessage: (channelId, messageId, response) =>
        Effect.tryPromise(() =>
          app.client.chat.update({
            channel: channelId,
            ts: messageId,
            text: response.text,
            blocks: response.blocks as any,
          })
        ).pipe(Effect.asVoid),
    })
  })
)

// Slack message handler
export function createSlackHandler(
  onMessage: (msg: BotMessage) => Effect.Effect<BotResponse>
) {
  return async ({ message, say }: SlackEventMiddlewareArgs<"message">) => {
    if (!message.subtype && "text" in message && message.text) {
      const botMessage: BotMessage = {
        platform: "slack",
        channelId: message.channel,
        userId: message.user!,
        text: message.text,
        threadId: message.thread_ts,
      }

      const response = await Effect.runPromise(onMessage(botMessage))
      await say({
        text: response.text,
        thread_ts: message.thread_ts,
        blocks: response.blocks as any,
      })
    }
  }
}
```

## Discord Adapter

```typescript
// apps/bot/src/adapters/discord.ts
import { Client, GatewayIntentBits, type Message } from "discord.js"
import { Effect, Layer, Config } from "effect"
import { BotService, type BotMessage, type BotResponse } from "../bot"

export const DiscordBotLive = Layer.effect(
  BotService,
  Effect.gen(function* () {
    const token = yield* Config.string("DISCORD_BOT_TOKEN")

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    })

    yield* Effect.tryPromise(() => client.login(token))

    return BotService.of({
      sendMessage: (channelId, response) =>
        Effect.gen(function* () {
          const channel = yield* Effect.tryPromise(() =>
            client.channels.fetch(channelId)
          )
          if (channel?.isTextBased()) {
            yield* Effect.tryPromise(() =>
              channel.send({ content: response.text })
            )
          }
        }),

      sendThreadReply: (channelId, threadId, response) =>
        Effect.gen(function* () {
          const channel = yield* Effect.tryPromise(() =>
            client.channels.fetch(threadId)
          )
          if (channel?.isThread()) {
            yield* Effect.tryPromise(() =>
              channel.send({ content: response.text })
            )
          }
        }),

      updateMessage: (channelId, messageId, response) =>
        Effect.gen(function* () {
          const channel = yield* Effect.tryPromise(() =>
            client.channels.fetch(channelId)
          )
          if (channel?.isTextBased()) {
            const message = yield* Effect.tryPromise(() =>
              channel.messages.fetch(messageId)
            )
            yield* Effect.tryPromise(() =>
              message.edit({ content: response.text })
            )
          }
        }),
    })
  })
)

// Discord message handler
export function createDiscordHandler(
  client: Client,
  onMessage: (msg: BotMessage) => Effect.Effect<BotResponse>
) {
  client.on("messageCreate", async (message: Message) => {
    // Ignore bot messages
    if (message.author.bot) return

    const botMessage: BotMessage = {
      platform: "discord",
      channelId: message.channelId,
      userId: message.author.id,
      text: message.content,
      threadId: message.channel.isThread() ? message.channel.id : undefined,
    }

    const response = await Effect.runPromise(onMessage(botMessage))
    await message.reply(response.text)
  })
}
```

## Message Handler with API Client

```typescript
// apps/bot/src/handler.ts
import { Effect } from "effect"
import { HttpApiClient, FetchHttpClient } from "@effect/platform"
import { AppApi } from "@my-app/api"
import type { BotMessage, BotResponse } from "./bot"

export function createMessageHandler(apiBaseUrl: string) {
  return (message: BotMessage): Effect.Effect<BotResponse> =>
    Effect.gen(function* () {
      const client = yield* HttpApiClient.make(AppApi, { baseUrl: apiBaseUrl })

      // Parse command from message
      const command = parseCommand(message.text)

      switch (command.type) {
        case "list-sessions": {
          const result = yield* client.sessions.list({
            urlParams: { limit: 10 },
          })
          return {
            text: `Found ${result.data.length} sessions`,
            blocks: formatSessionList(result.data),
          }
        }

        case "create-session": {
          const session = yield* client.sessions.create({
            payload: { title: command.title },
          })
          return {
            text: `Created session: ${session.title}`,
            blocks: formatSession(session),
          }
        }

        case "help":
        default:
          return {
            text: "Available commands:\n• list sessions\n• create session <title>\n• help",
          }
      }
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.catchAll((error) =>
        Effect.succeed({
          text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        })
      )
    )
}

type Command =
  | { type: "list-sessions" }
  | { type: "create-session"; title: string }
  | { type: "help" }

function parseCommand(text: string): Command {
  const lower = text.toLowerCase().trim()

  if (lower === "list sessions" || lower === "sessions") {
    return { type: "list-sessions" }
  }

  const createMatch = text.match(/create session (.+)/i)
  if (createMatch) {
    return { type: "create-session", title: createMatch[1].trim() }
  }

  return { type: "help" }
}
```

## Slack Block Formatting

```typescript
// apps/bot/src/formatters/slack.ts
import type { Session } from "@my-app/shared"

export function formatSessionList(sessions: Session[]) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Sessions (${sessions.length})*`,
      },
    },
    {
      type: "divider",
    },
    ...sessions.map((session) => ({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${session.title}*\nCreated: ${new Date(session.createdAt).toLocaleDateString()}`,
      },
      accessory: {
        type: "button",
        text: {
          type: "plain_text",
          text: "Open",
        },
        action_id: `open_session_${session.id}`,
      },
    })),
  ]
}

export function formatSession(session: Session) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${session.title}*`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `ID: \`${session.id}\` | Created: ${new Date(session.createdAt).toLocaleDateString()}`,
        },
      ],
    },
  ]
}
```

## Entry Point (Slack)

```typescript
// apps/bot/src/main.ts
import { App } from "@slack/bolt"
import { Effect, Layer, Config } from "effect"
import { createMessageHandler } from "./handler"
import { createSlackHandler } from "./adapters/slack"

const program = Effect.gen(function* () {
  const token = yield* Config.string("SLACK_BOT_TOKEN")
  const signingSecret = yield* Config.string("SLACK_SIGNING_SECRET")
  const appToken = yield* Config.string("SLACK_APP_TOKEN")
  const apiBaseUrl = yield* Config.string("API_BASE_URL").pipe(
    Config.withDefault("http://localhost:3000/v1")
  )

  const app = new App({
    token,
    signingSecret,
    socketMode: true,
    appToken,
  })

  const messageHandler = createMessageHandler(apiBaseUrl)
  const slackHandler = createSlackHandler(messageHandler)

  // Listen for messages
  app.message(slackHandler)

  // Listen for button actions
  app.action(/open_session_(.+)/, async ({ action, ack, respond }) => {
    await ack()
    const sessionId = (action as any).action_id.replace("open_session_", "")
    await respond(`Opening session ${sessionId}...`)
  })

  // Start the app
  yield* Effect.tryPromise(() => app.start())
  yield* Effect.log("Bot is running!")

  // Keep alive
  yield* Effect.never
})

Effect.runPromise(program).catch(console.error)
```

## SSE Event Listener

```typescript
// apps/bot/src/sync.ts
import { Effect, Stream } from "effect"
import { BotService } from "./bot"

export function createEventListener(
  apiBaseUrl: string,
  notifyChannel: string
) {
  return Effect.gen(function* () {
    const bot = yield* BotService

    const eventSource = new EventSource(`${apiBaseUrl}/events`)

    eventSource.addEventListener("session.created", async (e) => {
      const session = JSON.parse(e.data)
      yield* bot.sendMessage(notifyChannel, {
        text: `New session created: ${session.title}`,
      })
    })

    eventSource.addEventListener("session.deleted", async (e) => {
      const { id } = JSON.parse(e.data)
      yield* bot.sendMessage(notifyChannel, {
        text: `Session ${id} was deleted`,
      })
    })

    // Cleanup on effect finalization
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => eventSource.close())
    )

    // Keep connection alive
    yield* Effect.never
  })
}
```

## Slash Commands

```typescript
// apps/bot/src/commands/slack.ts
import type { App } from "@slack/bolt"
import { Effect } from "effect"
import { createMessageHandler } from "../handler"

export function registerSlashCommands(app: App, apiBaseUrl: string) {
  const handler = createMessageHandler(apiBaseUrl)

  app.command("/session", async ({ command, ack, respond }) => {
    await ack()

    const args = command.text.split(" ")
    const subcommand = args[0]

    const message = {
      platform: "slack" as const,
      channelId: command.channel_id,
      userId: command.user_id,
      text: `${subcommand} ${args.slice(1).join(" ")}`.trim(),
    }

    const response = await Effect.runPromise(handler(message))
    await respond({
      response_type: "ephemeral",
      text: response.text,
      blocks: response.blocks as any,
    })
  })
}
```

## Environment Configuration

```bash
# .env
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=xapp-...
API_BASE_URL=http://localhost:3000/v1

# For Discord
DISCORD_BOT_TOKEN=...
```

## Key Points

1. **Platform-agnostic interface**: BotService abstracts messaging operations
2. **Adapter pattern**: Slack/Discord specifics isolated in adapters
3. **Command parsing**: Simple text-based command extraction
4. **Rich formatting**: Platform-specific blocks/embeds
5. **SSE integration**: React to server events in real-time
6. **Effect-based**: Consistent error handling and composition
7. **Slash commands**: Native integration with platform features
