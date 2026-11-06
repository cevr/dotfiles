// The session data the Prime look reads, as plain values: the messages of a
// transcript, the parts of an assistant step and the sessions of a family.
// Each type is the part of OpenCode's own (the fork's packages/client
// generated types, through packages/plugin/src/tui/context.ts) a row reads,
// so the host's values are these values as they are: opencode/host.ts hands
// them over unchanged, and the compiler checks that they fit.

/** A record of named values, as a call's input and metadata are. */
export type Fields = Readonly<Record<string, unknown>>

/** One item of a call's result. */
export type ToolContent = { readonly type: "text"; readonly text: string } | { readonly type: "file" }

/** Why a call failed: the host's structured error, as far as a row reads it. */
export type ToolError = { readonly type?: string; readonly message?: string }

/** Where a call stands, with what it carries there. */
export type ToolState =
  | { readonly status: "streaming"; readonly input: string }
  | { readonly status: "running"; readonly input: Fields; readonly metadata: Fields }
  | {
      readonly status: "completed"
      readonly input: Fields
      readonly content: ReadonlyArray<ToolContent>
      readonly metadata?: Fields
    }
  | {
      readonly status: "error"
      readonly input: Fields
      readonly error: ToolError
      readonly content?: ReadonlyArray<ToolContent>
      readonly metadata?: Fields
    }

/** One tool call of an assistant step. */
export type ToolPart = {
  readonly type: "tool"
  readonly id: string
  readonly name: string
  readonly state: ToolState
  readonly time: { readonly created: number; readonly ran?: number; readonly completed?: number }
}

/** Answer text or a thought of an assistant step; a thought carries when it started and, once it ended, when it ended. */
export type WordsPart = {
  readonly type: "text" | "reasoning"
  readonly text: string
  readonly time?: { readonly created: number; readonly completed?: number }
}

/** One part of an assistant step. */
export type Part = WordsPart | ToolPart

/** When a message was made and, for a step or a shell run, when it ended. */
export type MessageTime = { readonly created: number; readonly completed?: number }

/** A model step: its parts and how it ended. */
export type AssistantMessage = {
  readonly id: string
  readonly type: "assistant"
  readonly time: MessageTime
  readonly content: ReadonlyArray<Part>
  readonly error?: { readonly type: string; readonly message: string }
  readonly retry?: { readonly attempt: number; readonly at: number; readonly error: { readonly message: string } }
}

/** A file the reader attached to a prompt. */
export type Attachment = {
  readonly mime: string
  readonly name?: string
  readonly source: { readonly type: "inline" } | { readonly type: "uri"; readonly uri: string }
}

/** The reader's prompt, with what came with it. */
export type UserMessage = {
  readonly id: string
  readonly type: "user"
  readonly time: MessageTime
  readonly text: string
  readonly files?: ReadonlyArray<Attachment>
  readonly skills?: ReadonlyArray<{ readonly name: string }>
  readonly agents?: ReadonlyArray<{ readonly name: string }>
}

/** A message another program put in the session: a background agent's or shell's stop notice, mail, a steer. */
export type SyntheticMessage = {
  readonly id: string
  readonly type: "synthetic"
  readonly time: MessageTime
  readonly text: string
  readonly description?: string
  readonly metadata?: Fields
}

/** A request's token usage, as the host counts it. */
export type Tokens = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}

/**
 * A compaction: who asked for it (`auto`, the runtime or a plugin acting on
 * its own, or `manual`), how it stands, and the usage of its own request.
 * A completed one carries its summary (a provider compaction its replacement
 * window in `native.messages` instead); a failed one its error.
 */
export type CompactionMessage = {
  readonly id: string
  readonly type: "compaction"
  readonly time: MessageTime
  readonly reason: "auto" | "manual"
  readonly tokens?: Tokens
} & (
  | { readonly status: "running"; readonly summary: string }
  | { readonly status: "completed"; readonly summary: string; readonly native?: { readonly messages?: unknown } }
  | { readonly status: "failed"; readonly error: { readonly type: string; readonly message: string } }
)

/** Every other message: the look draws none of them itself. */
export type OtherMessage = {
  readonly id: string
  readonly type: "agent-switched" | "model-switched" | "location-switched" | "system" | "skill" | "shell" | "idle"
  readonly time: MessageTime
}

/** One message of a session's transcript, in transcript order. */
export type Message = AssistantMessage | UserMessage | SyntheticMessage | CompactionMessage | OtherMessage

/** A session as the frame reads it: its place in its family, its title and what it runs. */
export type Session = {
  readonly id: string
  readonly parentID?: string | null
  readonly title?: string
  readonly agent?: string
  readonly model?: { readonly providerID: string; readonly id: string }
  readonly location?: { readonly directory: string }
  readonly time?: { readonly created: number }
}

/**
 * One part of an assistant step, by the `partID` a `session.part.*` slot
 * receives: a tool call by its call id, text and a thought by their ordinal
 * among the step's parts of that kind (`text:2`, `reasoning:0`).
 */
export function partOf(message: Message | undefined, partID: string): Part | undefined {
  if (message?.type !== "assistant") return undefined
  const tool = message.content.find((part) => part.type === "tool" && part.id === partID)
  if (tool) return tool
  const match = /^(text|reasoning):(\d+)$/.exec(partID)
  if (!match) return undefined
  return message.content.filter((part) => part.type === match[1])[Number(match[2])]
}

/** A part's words as the transcript shows them: the provider's redaction marker dropped, trimmed. */
export function words(text: string): string {
  return text.replace("[REDACTED]", "").trim()
}
